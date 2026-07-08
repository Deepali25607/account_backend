const express = require("express");
const db = require("../db");
const { auth, requireFeature } = require("../middleware");
const { tierHasFeature } = require("../entitlements");

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

/** RP-07 Supplier Report By Item — net qty & value purchased per item, broken
 * down by supplier, over a date range. Returns net confirmed (return docs
 * subtracted). Optional ?vendor_id and ?item_id filters. */
router.get("/supplier-by-item", (req, res) => {
  const { from, to } = range(req);
  const sign = "(CASE WHEN p.doc_type='return' THEN -1 ELSE 1 END)";
  let sql = `SELECT i.name AS item, i.sku, v.name AS vendor,
                    ROUND(SUM(${sign} * pl.qty), 3)        AS qty,
                    ROUND(SUM(${sign} * pl.line_total) /
                          NULLIF(SUM(${sign} * pl.qty), 0), 2) AS avg_price,
                    ROUND(SUM(${sign} * pl.line_total), 2)  AS value,
                    MAX(p.doc_date)                         AS last_purchase
             FROM purchase_lines pl
             JOIN purchases p ON p.id = pl.purchase_id
             JOIN vendors v   ON v.id = p.vendor_id
             JOIN items i     ON i.id = pl.item_id
             WHERE p.tenant_id=? AND p.status='confirmed' AND p.doc_date BETWEEN ? AND ?`;
  const params = [req.tenant.id, from, to];
  if (req.query.vendor_id) { sql += " AND p.vendor_id=?"; params.push(req.query.vendor_id); }
  if (req.query.item_id) { sql += " AND pl.item_id=?"; params.push(req.query.item_id); }
  sql += " GROUP BY pl.item_id, p.vendor_id ORDER BY i.name, value DESC";
  res.json(db.prepare(sql).all(...params));
});

/** RP-08 Supplier Wise Outstanding — per-supplier payables snapshot.
 * Mirrors RP-06 payables (doc_type='purchase', outstanding = grand_total - paid)
 * so totals reconcile, enriched with bill count, totals & oldest unpaid date
 * (for aging). Point-in-time: ignores the date range. */
router.get("/supplier-outstanding", (req, res) => {
  res.json(
    db.prepare(
      `SELECT v.name AS vendor, v.phone,
              COUNT(*)                                  AS bills,
              ROUND(SUM(p.grand_total), 2)              AS total_billed,
              ROUND(SUM(p.paid), 2)                     AS paid,
              ROUND(SUM(p.grand_total - p.paid), 2)     AS outstanding,
              MIN(CASE WHEN p.grand_total > p.paid THEN p.doc_date END) AS oldest_unpaid
       FROM purchases p JOIN vendors v ON v.id = p.vendor_id
       WHERE p.tenant_id=? AND p.doc_type='purchase'
       GROUP BY p.vendor_id HAVING outstanding > 0
       ORDER BY outstanding DESC`
    ).all(req.tenant.id)
  );
});

/** RP-09 Customer Wise Outstanding — per-customer receivables snapshot with
 * aging. Counts open invoices only (doc_type='sale', not cancelled, balance
 * due) so it reconciles with the Payments screen's open-bill list; each
 * invoice's balance falls into an aging bucket by days since doc_date.
 * Point-in-time: ignores the date range. */
router.get("/customer-outstanding", (req, res) => {
  const age = "CAST(julianday('now') - julianday(s.doc_date) AS INTEGER)";
  const bucket = (cond) => `ROUND(SUM(CASE WHEN ${cond} THEN s.grand_total - s.received ELSE 0 END), 2)`;
  res.json(
    db.prepare(
      `SELECT c.name AS customer, c.phone,
              COUNT(*)                                   AS bills,
              ROUND(SUM(s.grand_total), 2)               AS total_billed,
              ROUND(SUM(s.received), 2)                  AS received,
              ROUND(SUM(s.grand_total - s.received), 2)  AS outstanding,
              ${bucket(`${age} <= 30`)}                  AS "0-30",
              ${bucket(`${age} BETWEEN 31 AND 60`)}      AS "31-60",
              ${bucket(`${age} BETWEEN 61 AND 90`)}      AS "61-90",
              ${bucket(`${age} > 90`)}                   AS "90+",
              MIN(s.doc_date)                            AS oldest_unpaid
       FROM sales s JOIN customers c ON c.id = s.customer_id
       WHERE s.tenant_id=? AND s.doc_type='sale' AND s.status!='cancelled'
         AND s.grand_total > s.received
       GROUP BY s.customer_id
       ORDER BY outstanding DESC`
    ).all(req.tenant.id)
  );
});

/** RP-10 Bill Wise Profit — per-invoice gross profit over a date range.
 * Same basis as RP-05 so the rows sum to the Profit Estimate: revenue is the
 * subtotal (net of line discounts, ex-tax, sign-flipped for returns) and cost
 * is the stored cogs (already signed, negative on returns). Confirmed docs
 * only. Optional ?customer_id filter. */
router.get("/bill-profit", (req, res) => {
  const { from, to } = range(req);
  const sv = "(CASE WHEN s.doc_type='sale' THEN s.subtotal ELSE -s.subtotal END)";
  let sql = `SELECT s.doc_no, s.doc_type, s.doc_date, c.name AS customer,
                    ROUND(${sv}, 2)          AS sales_value,
                    ROUND(s.cogs, 2)         AS cost_value,
                    ROUND(${sv} - s.cogs, 2) AS gross_profit,
                    CASE WHEN s.subtotal != 0
                         THEN ROUND((${sv} - s.cogs) * 100.0 / ${sv}, 1)
                         ELSE 0 END          AS margin_pct
             FROM sales s JOIN customers c ON c.id=s.customer_id
             WHERE s.tenant_id=? AND s.status='confirmed' AND s.doc_date BETWEEN ? AND ?`;
  const params = [req.tenant.id, from, to];
  if (req.query.customer_id) { sql += " AND s.customer_id=?"; params.push(req.query.customer_id); }
  sql += " ORDER BY s.doc_date, s.id";
  res.json(db.prepare(sql).all(...params));
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
  // Supplier outstanding (payables) — sum each vendor's unpaid balance, counting
  // only those who are net owed (mirrors the /outstanding payables report).
  const payables = g(
    `SELECT COALESCE(SUM(outstanding),0) v FROM (
       SELECT SUM(p.grand_total - p.paid) AS outstanding
       FROM purchases p WHERE p.tenant_id=? AND p.doc_type='purchase'
       GROUP BY p.vendor_id HAVING outstanding > 0
     )`
  ).v;
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
  res.json({ sales30, purch30, stockValue: Math.round(stockValue * 100) / 100, payables: Math.round(payables * 100) / 100, lowStock, counts, trend });
});

/**
 * Business Assistant — plain-language insights for the dashboard card.
 * Each block is null when it has nothing useful to say, so the UI only renders
 * the lines that matter. Money is returned raw; the client formats currency.
 */
router.get("/assistant", (req, res) => {
  const t = req.tenant.id;
  const round = (n) => Math.round((n || 0) * 100) / 100;

  // Receivables — total outstanding & how many customers owe it (mirrors RP-06).
  const recv = db.prepare(
    `SELECT COUNT(*) AS customers, COALESCE(SUM(outstanding),0) AS total FROM (
       SELECT SUM(s.grand_total - s.received) AS outstanding
       FROM sales s WHERE s.tenant_id=? AND s.doc_type='sale'
       GROUP BY s.customer_id HAVING outstanding > 0
     )`
  ).get(t);
  const receivables = recv.total > 0 ? { total: round(recv.total), customers: recv.customers } : null;

  // Best-selling product this calendar month, ranked by quantity sold.
  const top = db.prepare(
    `SELECT i.name, COALESCE(SUM(sl.qty),0) AS qty, COALESCE(SUM(sl.line_total),0) AS revenue
     FROM sale_lines sl
     JOIN sales s ON s.id=sl.sale_id
     JOIN items i ON i.id=sl.item_id
     WHERE s.tenant_id=? AND s.doc_type='sale' AND s.status='confirmed'
       AND s.doc_date >= date('now','start of month')
     GROUP BY sl.item_id ORDER BY qty DESC, revenue DESC LIMIT 1`
  ).get(t);
  const topProduct = top && top.qty > 0 ? { name: top.name, qty: round(top.qty), revenue: round(top.revenue) } : null;

  // Gross profit this month (month-to-date) vs all of last month (mirrors RP-05).
  const profitFor = (from, to) => {
    const r = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN doc_type='sale' THEN subtotal ELSE -subtotal END),0) AS sales_value,
         COALESCE(SUM(cogs),0) AS cost_value
       FROM sales WHERE tenant_id=? AND status='confirmed' AND doc_date BETWEEN ? AND ?`
    ).get(t, from, to);
    return r.sales_value - r.cost_value;
  };
  const dt = (expr) => db.prepare(`SELECT date(${expr}) d`).get().d;
  const thisProfit = profitFor(dt("'now','start of month'"), dt("'now'"));
  const lastProfit = profitFor(dt("'now','start of month','-1 month'"), dt("'now','start of month','-1 day'"));
  let profit = null;
  if (thisProfit !== 0 || lastProfit !== 0) {
    const changePct = lastProfit !== 0 ? Math.round(((thisProfit - lastProfit) / Math.abs(lastProfit)) * 1000) / 10 : null;
    profit = { thisMonth: round(thisProfit), lastMonth: round(lastProfit), changePct, direction: thisProfit >= lastProfit ? "up" : "down" };
  }

  // GST filing countdown — GSTR-3B is due the 20th of the following month. We
  // surface the next upcoming 20th. Only relevant for GST-enabled plans.
  let gst = null;
  if (tierHasFeature(req.tenant.tier, "gst")) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let due = new Date(today.getFullYear(), today.getMonth(), 20);
    if (today > due) due = new Date(due.getFullYear(), due.getMonth() + 1, 20);
    const daysLeft = Math.round((due - today) / 86400000);
    gst = { ret: "GSTR-3B", dueDate: due.toISOString().slice(0, 10), daysLeft };
  }

  res.json({ receivables, topProduct, profit, gst });
});

module.exports = router;
