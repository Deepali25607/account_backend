/**
 * Payment In / Payment Out service — AC-06, shared by /api/payments (all tiers)
 * and /api/accounting/payments (kept for back-compat). Single source of truth so
 * the two entry points can never drift.
 *
 *  Payment In  (kind 'receipt') — money received from a customer; settles oldest
 *               open SALES first, surplus stays as an advance.
 *  Payment Out (kind 'payment') — money paid to a vendor; settles oldest open
 *               confirmed PURCHASES first, surplus stays as an advance.
 *
 * Receivable/payable tracking (the received/paid columns) works at every tier.
 * The double-entry ledger posting only happens when the tenant's plan includes
 * accounting (Standard+); Basic tenants still get accurate party balances.
 */
const db = require("./db");
const { ensureChart, postEntry } = require("./accounting");
const { tierHasFeature } = require("./entitlements");

const round = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const httpErr = (s, m) => { const e = new Error(m); e.httpStatus = s; return e; };

// Per-kind wiring so receipts (settle sales) and payments (settle purchases)
// share one allocation/ledger code path and can never drift.
const CFG = {
  receipt: {
    partyTable: "customers", partyName: "customer",
    docTable: "sales", partyCol: "customer_id", paidCol: "received",
    docFilter: "doc_type='sale' AND status!='cancelled'",
    memo: (account) => `Payment In (${account})`,
    entry: (cashCode, amt) => [{ code: cashCode, debit: amt }, { code: "1100", credit: amt }],
  },
  payment: {
    partyTable: "vendors", partyName: "vendor",
    docTable: "purchases", partyCol: "vendor_id", paidCol: "paid",
    docFilter: "doc_type='purchase' AND status='confirmed'",
    memo: (account) => `Payment Out (${account})`,
    entry: (cashCode, amt) => [{ code: "2000", debit: amt }, { code: cashCode, credit: amt }],
  },
};

/** Open bills (unsettled docs) for a party — powers bill-wise allocation in the UI. */
function openBills(tenantId, kind, partyId) {
  const c = CFG[kind];
  if (!c || !partyId) return [];
  return db.prepare(
    `SELECT id, doc_no, doc_date, grand_total, ${c.paidCol} AS paid,
            ROUND(grand_total - ${c.paidCol}, 2) AS outstanding
       FROM ${c.docTable}
      WHERE tenant_id=? AND ${c.partyCol}=? AND ${c.docFilter} AND grand_total > ${c.paidCol}
      ORDER BY doc_date, id`
  ).all(tenantId, partyId);
}

/** List payments, optionally filtered by kind, with the party name resolved. */
function listPayments(tenantId, kind) {
  const filter = kind === "receipt" || kind === "payment" ? "AND p.kind = ?" : "";
  const args = filter ? [tenantId, kind] : [tenantId];
  return db.prepare(
    `SELECT p.*,
            CASE WHEN p.kind='receipt' THEN c.name ELSE v.name END AS party_name
     FROM payments p
     LEFT JOIN customers c ON p.kind='receipt' AND c.id=p.party_id
     LEFT JOIN vendors   v ON p.kind='payment' AND v.id=p.party_id
     WHERE p.tenant_id=? ${filter}
     ORDER BY p.pay_date DESC, p.id DESC`
  ).all(...args);
}

/** Parties (customers for receipts, vendors for payments) with open balance. */
function partiesWithBalance(tenantId, kind) {
  if (kind === "receipt") {
    return db.prepare(
      `SELECT c.id, c.name,
              ROUND(COALESCE((SELECT SUM(s.grand_total - s.received) FROM sales s
                WHERE s.tenant_id=c.tenant_id AND s.customer_id=c.id
                  AND s.doc_type='sale' AND s.status!='cancelled' AND s.grand_total > s.received),0),2) AS outstanding
       FROM customers c WHERE c.tenant_id=? ORDER BY c.name`
    ).all(tenantId);
  }
  return db.prepare(
    `SELECT v.id, v.name,
            ROUND(COALESCE((SELECT SUM(p.grand_total - p.paid) FROM purchases p
              WHERE p.tenant_id=v.tenant_id AND p.vendor_id=v.id
                AND p.doc_type='purchase' AND p.status='confirmed' AND p.grand_total > p.paid),0),2) AS outstanding
     FROM vendors v WHERE v.tenant_id=? ORDER BY v.name`
  ).all(tenantId);
}

/**
 * Record a payment. `tenant` must carry { id, tier }. Returns
 * { id, allocations, unallocated, posted }.
 *
 * Allocation is bill-wise: pass `body.allocations` = [{ doc_id, amount }, …] to
 * settle specific invoices/bills by the amounts given. Omit it to fall back to
 * the default oldest-first (FIFO) auto-settlement. Either way any amount left
 * over after settling stays on the party as an advance.
 */
function recordPayment(tenant, body) {
  const tenantId = tenant.id;
  const { kind, party_id, account, amount, pay_date, note } = body || {};
  if (!["receipt", "payment"].includes(kind)) throw httpErr(400, "kind must be receipt or payment");
  if (!["cash", "bank"].includes(account)) throw httpErr(400, "account must be cash or bank");
  const amt = round(Number(amount));
  if (!(amt > 0)) throw httpErr(400, "amount must be positive");
  const date = pay_date || new Date().toISOString().slice(0, 10);
  const cashCode = account === "bank" ? "1010" : "1000";
  const postsLedger = tierHasFeature(tenant.tier, "accounting");
  if (postsLedger) ensureChart(tenantId);

  const c = CFG[kind];
  const explicit = Array.isArray(body?.allocations)
    ? body.allocations.filter((a) => round(a?.amount) > 0)
    : null;

  return db.transaction(() => {
    if (!db.prepare(`SELECT id FROM ${c.partyTable} WHERE id=? AND tenant_id=?`).get(party_id, tenantId))
      throw httpErr(400, `Unknown ${c.partyName}`);

    let left = amt;
    const allocations = [];
    const settle = (d, alloc) => {
      db.prepare(`UPDATE ${c.docTable} SET ${c.paidCol} = ${c.paidCol} + ? WHERE id=?`).run(alloc, d.id);
      allocations.push({ doc_id: d.id, doc_no: d.doc_no, amount: alloc });
      left = round(left - alloc);
    };

    if (explicit && explicit.length) {
      // Bill-wise: settle exactly the bills the user picked, in the order given.
      for (const a of explicit) {
        const d = db.prepare(
          `SELECT id, doc_no, grand_total, ${c.paidCol} AS paid FROM ${c.docTable}
            WHERE id=? AND tenant_id=? AND ${c.partyCol}=? AND ${c.docFilter}`
        ).get(a.doc_id, tenantId, party_id);
        if (!d) throw httpErr(400, "A selected bill is not open for this party");
        const openBal = round(d.grand_total - d.paid);
        const alloc = round(a.amount);
        if (alloc > openBal) throw httpErr(400, `Allocation for ${d.doc_no} exceeds its open balance`);
        if (alloc > left) throw httpErr(400, "Allocations exceed the payment amount");
        settle(d, alloc);
      }
    } else {
      // Default: auto-settle oldest open docs first.
      const docs = db.prepare(
        `SELECT id, doc_no, grand_total, ${c.paidCol} AS paid FROM ${c.docTable}
          WHERE tenant_id=? AND ${c.partyCol}=? AND ${c.docFilter} AND grand_total > ${c.paidCol}
          ORDER BY doc_date, id`
      ).all(tenantId, party_id);
      for (const d of docs) {
        if (left <= 0) break;
        settle(d, round(Math.min(left, d.grand_total - d.paid)));
      }
    }

    if (postsLedger)
      postEntry(tenantId, { date, memo: c.memo(account), ref_type: "payment" }, c.entry(cashCode, amt));

    const r = db.prepare(
      "INSERT INTO payments (tenant_id, kind, party_id, account, amount, pay_date, note) VALUES (?,?,?,?,?,?,?)"
    ).run(tenantId, kind, party_id, account, amt, date, note || null);
    return { id: r.lastInsertRowid, allocations, unallocated: round(left), posted: postsLedger };
  })();
}

module.exports = { listPayments, partiesWithBalance, openBills, recordPayment, round };
