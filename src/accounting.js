/**
 * Standard-tier accounting engine — BRD §6.6.
 *  AC-01  auto-post journal entries from purchase/sale transactions (no manual double-entry)
 *  AC-02  default chart of accounts, seeded per tenant
 *  AC-04  GST split into output tax (payable) and input credit (asset)
 *
 * Uses perpetual inventory: a sale credits Inventory at weighted-avg cost (COGS),
 * a purchase debits Inventory at cost. Every entry is internally balanced, so the
 * trial balance always reconciles.
 */
const db = require("./db");

// code → [name, type]
const DEFAULT_COA = {
  "1000": ["Cash", "asset"],
  "1010": ["Bank", "asset"],
  "1100": ["Accounts Receivable", "asset"],
  "1200": ["Inventory", "asset"],
  "1210": ["GST Input Credit", "asset"],
  "2000": ["Accounts Payable", "liability"],
  "2100": ["GST Payable", "liability"],
  "3000": ["Owner's Equity", "equity"],
  "4000": ["Sales Revenue", "income"],
  "4100": ["Other Charges Collected", "income"],   // additional charges billed on sales
  "4200": ["Discount Received", "income"],          // additional discount on purchases
  "4300": ["Round Off", "income"],                  // total round-off (gain credited / loss debited; nets either way)
  "5000": ["Cost of Goods Sold", "expense"],
  "5100": ["Discount Allowed", "expense"],          // additional discount on sales
  "5200": ["Purchase Expenses", "expense"],         // additional charges paid on purchases
  "5300": ["Operating Expenses", "expense"],        // business expenses (rent, salaries, utilities, …)
};

/**
 * Seed the default chart of accounts for a tenant (AC-02). Inserts any accounts
 * from DEFAULT_COA the tenant is missing, so charts seeded before new accounts
 * were added (e.g. discount/charges) get back-filled on the next post.
 */
function ensureChart(tenantId) {
  const existing = new Set(
    db.prepare("SELECT code FROM accounts WHERE tenant_id=?").all(tenantId).map((r) => r.code)
  );
  const missing = Object.entries(DEFAULT_COA).filter(([code]) => !existing.has(code));
  if (!missing.length) return;
  const ins = db.prepare("INSERT INTO accounts (tenant_id, code, name, type) VALUES (?,?,?,?)");
  const tx = db.transaction(() => {
    for (const [code, [name, type]] of missing) ins.run(tenantId, code, name, type);
  });
  tx();
}

function acct(tenantId, code) {
  const row = db.prepare("SELECT id FROM accounts WHERE tenant_id=? AND code=?").get(tenantId, code);
  if (!row) throw new Error(`Account ${code} missing — chart not initialised`);
  return row.id;
}

/** Write one balanced entry. `lines` = [{code, debit?, credit?}]. Skips zero lines. */
function postEntry(tenantId, { date, memo, ref_type, ref_id }, lines) {
  const clean = lines.filter((l) => round(l.debit) || round(l.credit));
  if (!clean.length) return;
  const e = db
    .prepare("INSERT INTO journal_entries (tenant_id, entry_date, memo, ref_type, ref_id) VALUES (?,?,?,?,?)")
    .run(tenantId, date, memo, ref_type || null, ref_id || null);
  const ins = db.prepare("INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES (?,?,?,?)");
  for (const l of clean) ins.run(e.lastInsertRowid, acct(tenantId, l.code), round(l.debit), round(l.credit));
}

/** AC-01: post a sale invoice (or reverse it for a credit note). */
function postSale(tenantId, sale) {
  ensureChart(tenantId);
  const s = sale.doc_type === "return" ? -1 : 1; // return reverses signs
  const cashCode = sale.payment_account === "bank" ? "1010" : "1000";
  postEntry(tenantId,
    { date: sale.doc_date, memo: `Sale ${sale.doc_no}`, ref_type: "sale", ref_id: sale.id },
    [
      { code: cashCode, debit: s * sale.received },                     // payment received (cash/bank)
      { code: "1100", debit: s * (sale.grand_total - sale.received) },  // receivable balance
      { code: "5100", debit: s * (sale.discount || 0) },               // discount allowed (contra-revenue)
      { code: "4000", credit: s * sale.subtotal },                      // revenue
      { code: "2100", credit: s * sale.tax_total },                     // output GST
      { code: "4100", credit: s * (sale.extra_charges || 0) },         // additional charges billed
      { code: "4300", credit: s * (sale.round_off || 0) },             // total round-off (keeps the entry balanced)
    ]
  );
  // cost of goods sold ↔ inventory
  postEntry(tenantId,
    { date: sale.doc_date, memo: `COGS ${sale.doc_no}`, ref_type: "sale_cogs", ref_id: sale.id },
    [
      { code: "5000", debit: s * sale.cogs },   // expense
      { code: "1200", credit: s * sale.cogs },  // reduce inventory
    ]
  );
}

/** AC-01: post a purchase (or reverse it for a purchase return). */
function postPurchase(tenantId, purchase) {
  ensureChart(tenantId);
  const s = purchase.doc_type === "return" ? -1 : 1;
  const cashCode = purchase.payment_account === "bank" ? "1010" : "1000";
  postEntry(tenantId,
    { date: purchase.doc_date, memo: `Purchase ${purchase.doc_no}`, ref_type: "purchase", ref_id: purchase.id },
    [
      { code: "1200", debit: s * purchase.subtotal },                      // inventory at cost
      { code: "1210", debit: s * purchase.tax_total },                     // input GST credit
      { code: "5200", debit: s * (purchase.extra_charges || 0) },          // additional charges paid
      { code: "4300", debit: s * (purchase.round_off || 0) },              // total round-off (keeps the entry balanced)
      { code: cashCode, credit: s * purchase.paid },                       // payment made (cash/bank)
      { code: "2000", credit: s * (purchase.grand_total - purchase.paid) },// payable balance
      { code: "4200", credit: s * (purchase.discount || 0) },             // additional discount received
    ]
  );
}

function round(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }

module.exports = { ensureChart, postSale, postPurchase, postEntry, DEFAULT_COA };
