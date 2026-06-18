const express = require("express");
const db = require("../db");
const { auth, requireFeature } = require("../middleware");

const router = express.Router();
router.use(auth);
router.use(requireFeature("reports"));

const range = (req) => ({
  from: req.query.from || "0000-01-01",
  to: req.query.to || "9999-12-31",
});

/** RP-01 Purchase Register (filter by date + vendor). */
router.get("/purchase-register", (req, res) => {
  const { from, to } = range(req);
  let sql = `SELECT p.doc_no, p.doc_type, p.doc_date, v.name AS vendor, p.subtotal, p.tax_total, p.grand_total, p.paid
             FROM purchases p JOIN vendors v ON v.id=p.vendor_id
             WHERE p.tenant_id=? AND p.doc_date BETWEEN ? AND ?`;
  const params = [req.tenant.id, from, to];
  if (req.query.vendor_id) { sql += " AND p.vendor_id=?"; params.push(req.query.vendor_id); }
  sql += " ORDER BY p.doc_date";
  res.json(db.prepare(sql).all(...params));
});

/** RP-02 Sales Register (filter by date + customer). */
router.get("/sales-register", (req, res) => {
  const { from, to } = range(req);
  let sql = `SELECT s.doc_no, s.doc_type, s.doc_date, c.name AS customer, s.subtotal, s.tax_total, s.grand_total, s.received
             FROM sales s JOIN customers c ON c.id=s.customer_id
             WHERE s.tenant_id=? AND s.doc_date BETWEEN ? AND ?`;
  const params = [req.tenant.id, from, to];
  if (req.query.customer_id) { sql += " AND s.customer_id=?"; params.push(req.query.customer_id); }
  sql += " ORDER BY s.doc_date";
  res.json(db.prepare(sql).all(...params));
});

/** RP-03 Stock Summary — qty & valuation per item. */
router.get("/stock-summary", (req, res) => {
  res.json(
    db.prepare(
      `SELECT id, sku, name, uom, stock_qty, cost_price,
              ROUND(stock_qty * cost_price, 2) AS valuation,
              reorder_lvl, (stock_qty <= reorder_lvl) AS low_stock
       FROM items WHERE tenant_id=? ORDER BY name`
    ).all(req.tenant.id)
  );
});

/** RP-04 Stock Movement / Ledger per item over a date range. */
router.get("/stock-movement", (req, res) => {
  const { from, to } = range(req);
  let sql = `SELECT m.created_at, i.sku, i.name AS item, m.qty_delta, m.reason, m.note
             FROM stock_movements m JOIN items i ON i.id=m.item_id
             WHERE m.tenant_id=? AND date(m.created_at) BETWEEN ? AND ?`;
  const params = [req.tenant.id, from, to];
  if (req.query.item_id) { sql += " AND m.item_id=?"; params.push(req.query.item_id); }
  sql += " ORDER BY m.created_at DESC, m.id DESC";
  res.json(db.prepare(sql).all(...params));
});

/** RP-05 Profit Estimate — sales value vs COGS over a period. */
router.get("/profit-estimate", (req, res) => {
  const { from, to } = range(req);
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN doc_type='sale' THEN subtotal ELSE -subtotal END),0) AS sales_value,
       COALESCE(SUM(cogs),0) AS cost_value
     FROM sales WHERE tenant_id=? AND status='confirmed' AND doc_date BETWEEN ? AND ?`
  ).get(req.tenant.id, from, to);
  row.gross_profit = Math.round((row.sales_value - row.cost_value) * 100) / 100;
  row.margin_pct = row.sales_value ? Math.round((row.gross_profit / row.sales_value) * 1000) / 10 : 0;
  res.json(row);
});

/** RP-06 Receivables / Payables Outstanding. */
router.get("/outstanding", (req, res) => {
  const receivables = db.prepare(
    `SELECT c.name, SUM(s.grand_total - s.received) AS outstanding
     FROM sales s JOIN customers c ON c.id=s.customer_id
     WHERE s.tenant_id=? AND s.doc_type='sale' GROUP BY c.id HAVING outstanding > 0 ORDER BY outstanding DESC`
  ).all(req.tenant.id);
  const payables = db.prepare(
    `SELECT v.name, SUM(p.grand_total - p.paid) AS outstanding
     FROM purchases p JOIN vendors v ON v.id=p.vendor_id
     WHERE p.tenant_id=? AND p.doc_type='purchase' GROUP BY v.id HAVING outstanding > 0 ORDER BY outstanding DESC`
  ).all(req.tenant.id);
  res.json({ receivables, payables });
});

/** Dashboard rollup (powers the home screen KPIs + chart). */
router.get("/dashboard", (req, res) => {
  const t = req.tenant.id;
  const g = (sql, ...p) => db.prepare(sql).get(t, ...p) || {};
  const sales30 = g(
    `SELECT COALESCE(SUM(grand_total),0) v FROM sales WHERE tenant_id=? AND doc_type='sale' AND doc_date >= date('now','-30 day')`
  ).v;
  const purch30 = g(
    `SELECT COALESCE(SUM(grand_total),0) v FROM purchases WHERE tenant_id=? AND doc_type='purchase' AND doc_date >= date('now','-30 day')`
  ).v;
  const stockValue = g(`SELECT COALESCE(SUM(stock_qty*cost_price),0) v FROM items WHERE tenant_id=?`).v;
  const lowStock = g(`SELECT COUNT(*) c FROM items WHERE tenant_id=? AND stock_qty <= reorder_lvl`).c;
  const counts = {
    items: g(`SELECT COUNT(*) c FROM items WHERE tenant_id=?`).c,
    customers: g(`SELECT COUNT(*) c FROM customers WHERE tenant_id=?`).c,
    vendors: g(`SELECT COUNT(*) c FROM vendors WHERE tenant_id=?`).c,
  };
  // last 6 months sales trend
  const trend = db.prepare(
    `SELECT substr(doc_date,1,7) AS month, COALESCE(SUM(grand_total),0) AS sales
     FROM sales WHERE tenant_id=? AND doc_type='sale' AND doc_date >= date('now','-6 month')
     GROUP BY month ORDER BY month`
  ).all(t);
  res.json({ sales30, purch30, stockValue: Math.round(stockValue * 100) / 100, lowStock, counts, trend });
});

module.exports = router;
