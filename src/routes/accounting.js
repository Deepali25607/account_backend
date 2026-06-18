const express = require("express");
const db = require("../db");
const { auth, requireFeature } = require("../middleware");
const { ensureChart, postEntry } = require("../accounting");
const { logAction } = require("../middleware");
const { listPayments, recordPayment } = require("../payment-service");

const router = express.Router();
router.use(auth);
router.use(requireFeature("accounting")); // Standard & Premium only (§5.2)
router.use((req, res, next) => { ensureChart(req.tenant.id); next(); });

const range = (req) => ({ from: req.query.from || "0000-01-01", to: req.query.to || "9999-12-31" });

/** AC-02: chart of accounts. */
router.get("/accounts", (req, res) => {
  res.json(db.prepare("SELECT * FROM accounts WHERE tenant_id=? ORDER BY code").all(req.tenant.id));
});

/** Journal — every auto-posted entry with its balanced lines (AC-01 transparency). */
router.get("/journal", (req, res) => {
  const { from, to } = range(req);
  const entries = db.prepare(
    `SELECT * FROM journal_entries WHERE tenant_id=? AND entry_date BETWEEN ? AND ? ORDER BY entry_date DESC, id DESC`
  ).all(req.tenant.id, from, to);
  const lineStmt = db.prepare(
    `SELECT jl.debit, jl.credit, a.code, a.name FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.entry_id=?`
  );
  res.json(entries.map((e) => ({ ...e, lines: lineStmt.all(e.id) })));
});

/** AC-03: Trial Balance — net debit/credit per account. */
router.get("/trial-balance", (req, res) => {
  const rows = db.prepare(
    `SELECT a.code, a.name, a.type,
            ROUND(COALESCE(SUM(jl.debit),0),2)  AS debit,
            ROUND(COALESCE(SUM(jl.credit),0),2) AS credit
     FROM accounts a
     LEFT JOIN journal_lines jl ON jl.account_id=a.id
     LEFT JOIN journal_entries je ON je.id=jl.entry_id
     WHERE a.tenant_id=?
     GROUP BY a.id ORDER BY a.code`
  ).all(req.tenant.id);
  const out = rows.map((r) => {
    const net = r.debit - r.credit;
    return { ...r, debit_balance: net > 0 ? round(net) : 0, credit_balance: net < 0 ? round(-net) : 0 };
  });
  const totals = out.reduce((a, r) => ({ debit: a.debit + r.debit_balance, credit: a.credit + r.credit_balance }), { debit: 0, credit: 0 });
  res.json({ rows: out, totals: { debit: round(totals.debit), credit: round(totals.credit) }, balanced: round(totals.debit) === round(totals.credit) });
});

/** AC-03: Profit & Loss over a period. */
router.get("/pnl", (req, res) => {
  const { from, to } = range(req);
  const byType = (type) => db.prepare(
    `SELECT a.name, ROUND(COALESCE(SUM(jl.credit - jl.debit),0),2) AS amount
     FROM accounts a
     LEFT JOIN journal_lines jl ON jl.account_id=a.id
     LEFT JOIN journal_entries je ON je.id=jl.entry_id AND je.entry_date BETWEEN ? AND ?
     WHERE a.tenant_id=? AND a.type=? GROUP BY a.id HAVING amount <> 0`
  ).all(from, to, req.tenant.id, type);
  const income = byType("income"); // credit-normal → positive = income
  const expenseRaw = byType("expense");
  const expense = expenseRaw.map((e) => ({ ...e, amount: -e.amount })); // expense is debit-normal
  const totalIncome = round(income.reduce((s, r) => s + r.amount, 0));
  const totalExpense = round(expense.reduce((s, r) => s + r.amount, 0));
  res.json({ income, expense, totalIncome, totalExpense, netProfit: round(totalIncome - totalExpense) });
});

/** AC-03: Balance Sheet as at `to` date. */
router.get("/balance-sheet", (req, res) => {
  const to = req.query.to || "9999-12-31";
  const bal = (types, normal) => {
    const rows = db.prepare(
      `SELECT a.name, ROUND(COALESCE(SUM(${normal === "debit" ? "jl.debit - jl.credit" : "jl.credit - jl.debit"}),0),2) AS amount
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id=a.id
       LEFT JOIN journal_entries je ON je.id=jl.entry_id AND je.entry_date <= ?
       WHERE a.tenant_id=? AND a.type IN (${types.map(() => "?").join(",")}) GROUP BY a.id HAVING amount <> 0`
    ).all(to, req.tenant.id, ...types);
    return rows;
  };
  const assets = bal(["asset"], "debit");
  const liabilities = bal(["liability"], "credit");
  const equity = bal(["equity"], "credit");
  // retained earnings closes income & expense into equity. Both use (credit-debit):
  // income (credit-normal) lands positive, expense (debit-normal) lands negative.
  const pl = db.prepare(
    `SELECT ROUND(COALESCE(SUM(jl.credit - jl.debit),0),2) net
     FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id JOIN journal_entries je ON je.id=jl.entry_id
     WHERE a.tenant_id=? AND je.entry_date<=? AND a.type IN ('income','expense')`
  ).get(req.tenant.id, to).net;
  const retained = round(pl);
  const sum = (a) => round(a.reduce((s, r) => s + r.amount, 0));
  const totalAssets = sum(assets);
  const totalLiab = sum(liabilities);
  const totalEquity = round(sum(equity) + retained);
  res.json({
    assets, liabilities, equity, retainedEarnings: retained,
    totalAssets, totalLiabilities: totalLiab, totalEquity,
    balanced: totalAssets === round(totalLiab + totalEquity),
  });
});

/** AC-05: GST summary — output tax (on sales) vs input credit (on purchases). */
router.get("/gst-summary", (req, res) => {
  const { from, to } = range(req);
  const output = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='sale' THEN tax_total ELSE -tax_total END),0) v
     FROM sales WHERE tenant_id=? AND doc_date BETWEEN ? AND ?`
  ).get(req.tenant.id, from, to).v;
  const input = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='purchase' THEN tax_total ELSE -tax_total END),0) v
     FROM purchases WHERE tenant_id=? AND doc_date BETWEEN ? AND ?`
  ).get(req.tenant.id, from, to).v;
  res.json({
    outputTax: round(output), inputCredit: round(input), netPayable: round(output - input),
  });
});

/** AC-05: HSN/SAC-wise summary of outward supplies (GSTR-1 style). HSN comes
 *  from the item master automatically — nothing is keyed per invoice. */
router.get("/hsn-summary", (req, res) => {
  const { from, to } = range(req);
  const rows = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(i.hsn),''),'—') AS hsn,
            l.tax_rate AS rate,
            ROUND(SUM(CASE WHEN s.doc_type='sale' THEN l.qty ELSE -l.qty END),2) AS qty,
            ROUND(SUM(CASE WHEN s.doc_type='sale' THEN l.qty*l.unit_price ELSE -l.qty*l.unit_price END),2) AS taxable,
            ROUND(SUM(CASE WHEN s.doc_type='sale' THEN (l.line_total - l.qty*l.unit_price) ELSE -(l.line_total - l.qty*l.unit_price) END),2) AS tax,
            ROUND(SUM(CASE WHEN s.doc_type='sale' THEN l.line_total ELSE -l.line_total END),2) AS total
     FROM sale_lines l
     JOIN sales s ON s.id = l.sale_id
     JOIN items i ON i.id = l.item_id
     WHERE s.tenant_id=? AND s.doc_date BETWEEN ? AND ? AND s.status!='cancelled'
     GROUP BY hsn, l.tax_rate
     HAVING total <> 0
     ORDER BY taxable DESC`
  ).all(req.tenant.id, from, to);
  const totals = rows.reduce((a, r) => ({
    taxable: a.taxable + r.taxable, tax: a.tax + r.tax, total: a.total + r.total,
  }), { taxable: 0, tax: 0, total: 0 });
  res.json({ rows, totals: { taxable: round(totals.taxable), tax: round(totals.tax), total: round(totals.total) } });
});

/* ── AC-06: bank & cash receipts / payments — delegate to the shared service
   (the dedicated /api/payments module is the primary entry point). ── */

router.get("/payments", (req, res) => {
  res.json(listPayments(req.tenant.id, req.query.kind));
});

router.post("/payments", (req, res) => {
  try {
    const result = recordPayment(req.tenant, req.body);
    logAction(req, "create", "payment", result.id);
    res.status(201).json(db.prepare("SELECT * FROM payments WHERE id=?").get(result.id));
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: e.message });
  }
});

function round(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }

module.exports = router;
