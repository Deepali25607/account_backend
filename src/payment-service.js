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

  return db.transaction(() => {
    let left = amt;
    const allocations = [];

    if (kind === "receipt") {
      if (!db.prepare("SELECT id FROM customers WHERE id=? AND tenant_id=?").get(party_id, tenantId))
        throw httpErr(400, "Unknown customer");
      const docs = db.prepare(
        "SELECT id, doc_no, grand_total, received FROM sales WHERE tenant_id=? AND customer_id=? AND doc_type='sale' AND status!='cancelled' AND grand_total>received ORDER BY doc_date, id"
      ).all(tenantId, party_id);
      for (const d of docs) {
        if (left <= 0) break;
        const alloc = round(Math.min(left, d.grand_total - d.received));
        db.prepare("UPDATE sales SET received = received + ? WHERE id=?").run(alloc, d.id);
        allocations.push({ doc_no: d.doc_no, amount: alloc });
        left = round(left - alloc);
      }
      if (postsLedger)
        postEntry(tenantId, { date, memo: `Payment In (${account})`, ref_type: "payment" },
          [{ code: cashCode, debit: amt }, { code: "1100", credit: amt }]);
    } else {
      if (!db.prepare("SELECT id FROM vendors WHERE id=? AND tenant_id=?").get(party_id, tenantId))
        throw httpErr(400, "Unknown vendor");
      const docs = db.prepare(
        "SELECT id, doc_no, grand_total, paid FROM purchases WHERE tenant_id=? AND vendor_id=? AND doc_type='purchase' AND status='confirmed' AND grand_total>paid ORDER BY doc_date, id"
      ).all(tenantId, party_id);
      for (const d of docs) {
        if (left <= 0) break;
        const alloc = round(Math.min(left, d.grand_total - d.paid));
        db.prepare("UPDATE purchases SET paid = paid + ? WHERE id=?").run(alloc, d.id);
        allocations.push({ doc_no: d.doc_no, amount: alloc });
        left = round(left - alloc);
      }
      if (postsLedger)
        postEntry(tenantId, { date, memo: `Payment Out (${account})`, ref_type: "payment" },
          [{ code: "2000", debit: amt }, { code: cashCode, credit: amt }]);
    }

    const r = db.prepare(
      "INSERT INTO payments (tenant_id, kind, party_id, account, amount, pay_date, note) VALUES (?,?,?,?,?,?,?)"
    ).run(tenantId, kind, party_id, account, amt, date, note || null);
    return { id: r.lastInsertRowid, allocations, unallocated: round(left), posted: postsLedger };
  })();
}

module.exports = { listPayments, partiesWithBalance, recordPayment, round };
