/**
 * Read-only query tools for the "Ask your books" AI assistant.
 *
 * Safety model: the model NEVER writes SQL and NEVER sees another tenant's
 * data. It can only invoke the whitelisted tools below; every query is a
 * prepared statement with the tenant id injected server-side from the JWT.
 * Row caps keep responses (and token spend) bounded.
 */
const db = require("./db");

const round = (n) => Math.round((n || 0) * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateOr = (v, fallback) => (typeof v === "string" && DATE_RE.test(v) ? v : fallback);
const like = (s) => `%${String(s || "").trim()}%`;

/* ------------------------------------------------------------------ tools */

function business_snapshot(t) {
  const g = (sql, ...p) => db.prepare(sql).get(t, ...p) || {};
  const sales30 = g(`SELECT COALESCE(SUM(grand_total),0) v FROM sales WHERE tenant_id=? AND doc_type='sale' AND doc_date >= date('now','-30 day')`).v;
  const purchases30 = g(`SELECT COALESCE(SUM(grand_total),0) v FROM purchases WHERE tenant_id=? AND doc_type='purchase' AND doc_date >= date('now','-30 day')`).v;
  const stockValue = g(`SELECT COALESCE(SUM(stock_qty*cost_price),0) v FROM items WHERE tenant_id=?`).v;
  const lowStockItems = g(`SELECT COUNT(*) c FROM items WHERE tenant_id=? AND stock_qty <= reorder_lvl`).c;
  const receivables = g(`SELECT COALESCE(SUM(o),0) v FROM (SELECT SUM(grand_total-received) o FROM sales WHERE tenant_id=? AND doc_type='sale' GROUP BY customer_id HAVING o>0)`).v;
  const payables = g(`SELECT COALESCE(SUM(o),0) v FROM (SELECT SUM(grand_total-paid) o FROM purchases WHERE tenant_id=? AND doc_type='purchase' GROUP BY vendor_id HAVING o>0)`).v;
  const profitMTD = g(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='sale' THEN subtotal ELSE -subtotal END),0) - COALESCE(SUM(cogs),0) v
     FROM sales WHERE tenant_id=? AND status='confirmed' AND doc_date >= date('now','start of month')`
  ).v;
  const counts = {
    items: g(`SELECT COUNT(*) c FROM items WHERE tenant_id=?`).c,
    customers: g(`SELECT COUNT(*) c FROM customers WHERE tenant_id=?`).c,
    vendors: g(`SELECT COUNT(*) c FROM vendors WHERE tenant_id=?`).c,
  };
  const salesTrend6m = db.prepare(
    `SELECT substr(doc_date,1,7) AS month, ROUND(COALESCE(SUM(grand_total),0),2) AS sales
     FROM sales WHERE tenant_id=? AND doc_type='sale' AND doc_date >= date('now','-6 month')
     GROUP BY month ORDER BY month`
  ).all(t);
  return {
    sales_last_30_days: round(sales30), purchases_last_30_days: round(purchases30),
    stock_value: round(stockValue), receivables_outstanding: round(receivables),
    payables_outstanding: round(payables), gross_profit_month_to_date: round(profitMTD),
    low_stock_items: lowStockItems, counts, sales_trend_6_months: salesTrend6m,
  };
}

function sales_report(t, inp = {}) {
  const from = dateOr(inp.from, "0000-01-01");
  const to = dateOr(inp.to, "9999-12-31");
  const sign = "(CASE WHEN s.doc_type='sale' THEN 1 ELSE -1 END)";
  let where = `s.tenant_id=? AND s.status='confirmed' AND s.doc_date BETWEEN ? AND ?`;
  const params = [t, from, to];
  if (inp.customer) { where += ` AND c.name LIKE ?`; params.push(like(inp.customer)); }

  const groups = {
    month: { key: "substr(s.doc_date,1,7)", label: "month" },
    customer: { key: "c.name", label: "customer" },
  };
  const g = groups[inp.group_by];
  if (inp.group_by === "item") {
    const rows = db.prepare(
      `SELECT i.name AS item, ROUND(SUM(${sign}*sl.qty),3) AS qty,
              ROUND(SUM(${sign}*sl.line_total),2) AS revenue
       FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id
       JOIN customers c ON c.id=s.customer_id JOIN items i ON i.id=sl.item_id
       WHERE ${where} GROUP BY sl.item_id ORDER BY revenue DESC LIMIT 100`
    ).all(...params);
    return { from, to, group_by: "item", rows };
  }
  if (g) {
    const rows = db.prepare(
      `SELECT ${g.key} AS ${g.label}, COUNT(*) AS invoices,
              ROUND(SUM(${sign}*s.grand_total),2) AS revenue,
              ROUND(SUM(${sign}*s.subtotal) - SUM(s.cogs),2) AS gross_profit
       FROM sales s JOIN customers c ON c.id=s.customer_id
       WHERE ${where} GROUP BY ${g.key} ORDER BY revenue DESC LIMIT 100`
    ).all(...params);
    return { from, to, group_by: inp.group_by, rows };
  }
  const row = db.prepare(
    `SELECT COUNT(*) AS invoices,
            ROUND(COALESCE(SUM(${sign}*s.grand_total),0),2) AS revenue,
            ROUND(COALESCE(SUM(${sign}*s.subtotal),0) - COALESCE(SUM(s.cogs),0),2) AS gross_profit,
            ROUND(COALESCE(SUM(s.tax_total*${sign}),0),2) AS tax_collected
     FROM sales s JOIN customers c ON c.id=s.customer_id WHERE ${where}`
  ).get(...params);
  return { from, to, totals: row };
}

function purchases_report(t, inp = {}) {
  const from = dateOr(inp.from, "0000-01-01");
  const to = dateOr(inp.to, "9999-12-31");
  const sign = "(CASE WHEN p.doc_type='purchase' THEN 1 ELSE -1 END)";
  let where = `p.tenant_id=? AND p.status='confirmed' AND p.doc_date BETWEEN ? AND ?`;
  const params = [t, from, to];
  if (inp.vendor) { where += ` AND v.name LIKE ?`; params.push(like(inp.vendor)); }

  if (inp.group_by === "item") {
    const rows = db.prepare(
      `SELECT i.name AS item, ROUND(SUM(${sign}*pl.qty),3) AS qty,
              ROUND(SUM(${sign}*pl.line_total),2) AS value
       FROM purchase_lines pl JOIN purchases p ON p.id=pl.purchase_id
       JOIN vendors v ON v.id=p.vendor_id JOIN items i ON i.id=pl.item_id
       WHERE ${where} GROUP BY pl.item_id ORDER BY value DESC LIMIT 100`
    ).all(...params);
    return { from, to, group_by: "item", rows };
  }
  const groups = { month: "substr(p.doc_date,1,7)", vendor: "v.name" };
  const key = groups[inp.group_by];
  if (key) {
    const rows = db.prepare(
      `SELECT ${key} AS ${inp.group_by}, COUNT(*) AS bills,
              ROUND(SUM(${sign}*p.grand_total),2) AS value
       FROM purchases p JOIN vendors v ON v.id=p.vendor_id
       WHERE ${where} GROUP BY ${key} ORDER BY value DESC LIMIT 100`
    ).all(...params);
    return { from, to, group_by: inp.group_by, rows };
  }
  const row = db.prepare(
    `SELECT COUNT(*) AS bills, ROUND(COALESCE(SUM(${sign}*p.grand_total),0),2) AS value
     FROM purchases p JOIN vendors v ON v.id=p.vendor_id WHERE ${where}`
  ).get(...params);
  return { from, to, totals: row };
}

function outstanding_report(t, inp = {}) {
  const side = inp.side === "receivables" || inp.side === "payables" ? inp.side : "both";
  const out = {};
  if (side !== "payables") {
    const age = "CAST(julianday('now') - julianday(s.doc_date) AS INTEGER)";
    const bucket = (cond) => `ROUND(SUM(CASE WHEN ${cond} THEN s.grand_total - s.received ELSE 0 END),2)`;
    out.receivables = db.prepare(
      `SELECT c.name AS customer, c.phone, COUNT(*) AS open_invoices,
              ROUND(SUM(s.grand_total - s.received),2) AS outstanding,
              ${bucket(`${age} <= 30`)} AS due_0_30_days,
              ${bucket(`${age} BETWEEN 31 AND 60`)} AS due_31_60_days,
              ${bucket(`${age} > 60`)} AS due_over_60_days,
              MIN(s.doc_date) AS oldest_invoice
       FROM sales s JOIN customers c ON c.id=s.customer_id
       WHERE s.tenant_id=? AND s.doc_type='sale' AND s.status!='cancelled' AND s.grand_total > s.received
       GROUP BY s.customer_id ORDER BY outstanding DESC LIMIT 100`
    ).all(t);
    out.total_receivable = round(out.receivables.reduce((a, r) => a + r.outstanding, 0));
  }
  if (side !== "receivables") {
    out.payables = db.prepare(
      `SELECT v.name AS vendor, v.phone, COUNT(*) AS bills,
              ROUND(SUM(p.grand_total - p.paid),2) AS outstanding,
              MIN(CASE WHEN p.grand_total > p.paid THEN p.doc_date END) AS oldest_unpaid
       FROM purchases p JOIN vendors v ON v.id=p.vendor_id
       WHERE p.tenant_id=? AND p.doc_type='purchase'
       GROUP BY p.vendor_id HAVING outstanding > 0 ORDER BY outstanding DESC LIMIT 100`
    ).all(t);
    out.total_payable = round(out.payables.reduce((a, r) => a + r.outstanding, 0));
  }
  return out;
}

function stock_report(t, inp = {}) {
  let where = `tenant_id=?`;
  const params = [t];
  if (inp.query) { where += ` AND (name LIKE ? OR sku LIKE ?)`; params.push(like(inp.query), like(inp.query)); }
  if (inp.low_stock_only) where += ` AND stock_qty <= reorder_lvl`;
  const rows = db.prepare(
    `SELECT sku, name, uom, ROUND(stock_qty,3) AS stock_qty, ROUND(cost_price,2) AS cost_price,
            ROUND(stock_qty*cost_price,2) AS stock_value, reorder_lvl,
            (stock_qty <= reorder_lvl) AS low_stock
     FROM items WHERE ${where} ORDER BY stock_value DESC LIMIT 50`
  ).all(...params);
  const total = db.prepare(`SELECT COUNT(*) c, ROUND(COALESCE(SUM(stock_qty*cost_price),0),2) v FROM items WHERE ${where}`).get(...params);
  return { items_shown: rows.length, items_matching: total.c, total_stock_value: total.v, rows };
}

function expenses_report(t, inp = {}) {
  const from = dateOr(inp.from, "0000-01-01");
  const to = dateOr(inp.to, "9999-12-31");
  const key = inp.group_by === "month" ? "substr(expense_date,1,7)" : "category";
  const label = inp.group_by === "month" ? "month" : "category";
  const rows = db.prepare(
    `SELECT ${key} AS ${label}, COUNT(*) AS entries, ROUND(SUM(amount),2) AS total
     FROM expenses WHERE tenant_id=? AND expense_date BETWEEN ? AND ?
     GROUP BY ${key} ORDER BY total DESC LIMIT 100`
  ).all(t, from, to);
  const total = db.prepare(`SELECT ROUND(COALESCE(SUM(amount),0),2) v FROM expenses WHERE tenant_id=? AND expense_date BETWEEN ? AND ?`).get(t, from, to).v;
  return { from, to, total_expenses: total, rows };
}

function cash_report(t, inp = {}) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const from = dateOr(inp.from, todayStr);
  const to = dateOr(inp.to, from === todayStr ? todayStr : "9999-12-31");
  const side = (acct) => {
    const pay = (kind) =>
      db.prepare(`SELECT ROUND(COALESCE(SUM(amount),0),2) v FROM payments WHERE tenant_id=? AND kind=? AND account=? AND pay_date BETWEEN ? AND ?`)
        .get(t, kind, acct, from, to).v;
    const exp = db.prepare(`SELECT ROUND(COALESCE(SUM(amount),0),2) v FROM expenses WHERE tenant_id=? AND account=? AND expense_date BETWEEN ? AND ?`)
      .get(t, acct, from, to).v;
    const received = pay("receipt"), paid = pay("payment");
    return { received_from_customers: received, paid_to_suppliers: paid, expenses: exp, net: round(received - paid - exp) };
  };
  return { from, to, cash: side("cash"), bank: side("bank") };
}

function list_documents(t, inp = {}) {
  const kind = inp.kind === "purchase" ? "purchase" : "sale";
  const from = dateOr(inp.from, "0000-01-01");
  const to = dateOr(inp.to, "9999-12-31");
  const limit = Math.min(Math.max(parseInt(inp.limit, 10) || 10, 1), 20);
  if (kind === "sale") {
    let where = `s.tenant_id=? AND s.doc_date BETWEEN ? AND ?`;
    const params = [t, from, to];
    if (inp.party) { where += ` AND c.name LIKE ?`; params.push(like(inp.party)); }
    return db.prepare(
      `SELECT s.doc_no, s.doc_type, s.doc_date, c.name AS customer, s.status,
              ROUND(s.grand_total,2) AS grand_total, ROUND(s.received,2) AS received,
              ROUND(s.grand_total - s.received,2) AS balance_due
       FROM sales s JOIN customers c ON c.id=s.customer_id
       WHERE ${where} ORDER BY s.doc_date DESC, s.id DESC LIMIT ${limit}`
    ).all(...params);
  }
  let where = `p.tenant_id=? AND p.doc_date BETWEEN ? AND ?`;
  const params = [t, from, to];
  if (inp.party) { where += ` AND v.name LIKE ?`; params.push(like(inp.party)); }
  return db.prepare(
    `SELECT p.doc_no, p.doc_type, p.doc_date, v.name AS vendor, p.status,
            ROUND(p.grand_total,2) AS grand_total, ROUND(p.paid,2) AS paid,
            ROUND(p.grand_total - p.paid,2) AS balance_due
     FROM purchases p JOIN vendors v ON v.id=p.vendor_id
     WHERE ${where} ORDER BY p.doc_date DESC, p.id DESC LIMIT ${limit}`
  ).all(...params);
}

/* ------------------------------------------- schemas shown to the model */

const dateProps = {
  from: { type: "string", description: "Start date YYYY-MM-DD (inclusive). Omit for all time." },
  to: { type: "string", description: "End date YYYY-MM-DD (inclusive). Omit for today/all time." },
};

const TOOLS = [
  {
    name: "business_snapshot",
    description: "Overall health of the business right now: sales & purchases (last 30 days), gross profit this month, stock value, receivables (money customers owe us), payables (money we owe suppliers), low-stock count, record counts and a 6-month sales trend. Call this first for broad questions like 'how is my business doing?'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "sales_report",
    description: "Confirmed sales over a period (returns are subtracted). Without group_by, returns totals: invoice count, revenue, gross profit, tax collected. group_by 'month'|'customer'|'item' breaks the numbers down. Optional customer filter (partial name match).",
    input_schema: {
      type: "object",
      properties: { ...dateProps, group_by: { type: "string", enum: ["month", "customer", "item"] }, customer: { type: "string", description: "Filter by customer name (partial match)" } },
      required: [],
    },
  },
  {
    name: "purchases_report",
    description: "Confirmed purchases over a period (returns subtracted). Without group_by, returns totals. group_by 'month'|'vendor'|'item' breaks it down. Optional vendor filter (partial name match).",
    input_schema: {
      type: "object",
      properties: { ...dateProps, group_by: { type: "string", enum: ["month", "vendor", "item"] }, vendor: { type: "string", description: "Filter by supplier name (partial match)" } },
      required: [],
    },
  },
  {
    name: "outstanding_report",
    description: "Who owes money right now. Receivables: per-customer outstanding with aging buckets (0-30 / 31-60 / 60+ days) and phone numbers. Payables: per-supplier outstanding with oldest unpaid bill date.",
    input_schema: { type: "object", properties: { side: { type: "string", enum: ["receivables", "payables", "both"] } }, required: [] },
  },
  {
    name: "stock_report",
    description: "Current stock per item: quantity, unit cost, stock value, reorder level and low-stock flag, plus total stock value. Optional name/SKU search and low_stock_only filter. Top 50 items by value.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search by item name or SKU (partial match)" }, low_stock_only: { type: "boolean" } },
      required: [],
    },
  },
  {
    name: "expenses_report",
    description: "Business expenses over a period grouped by category (default) or month, with an overall total. These are operating expenses recorded outside purchases (rent, salary, electricity...).",
    input_schema: {
      type: "object",
      properties: { ...dateProps, group_by: { type: "string", enum: ["category", "month"] } },
      required: [],
    },
  },
  {
    name: "cash_report",
    description: "Money movement through cash and bank over a period (defaults to today): received from customers, paid to suppliers, expenses, and the net. Use for 'today's cash report' or 'how much cash came in this week?'.",
    input_schema: { type: "object", properties: { ...dateProps }, required: [] },
  },
  {
    name: "list_documents",
    description: "Most recent individual invoices/bills, newest first (max 20): doc number, date, party, status, total and balance due. Use for questions about specific invoices, e.g. 'show my last 5 sales' or 'unpaid bills from Sharma'.",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["sale", "purchase"] }, party: { type: "string", description: "Filter by customer/supplier name (partial match)" }, ...dateProps, limit: { type: "integer", minimum: 1, maximum: 20 } },
      required: ["kind"],
    },
  },
];

const RUNNERS = { business_snapshot, sales_report, purchases_report, outstanding_report, stock_report, expenses_report, cash_report, list_documents };

/** Execute one tool for a tenant. Throws on unknown tool. */
function runTool(tenantId, name, input) {
  const fn = RUNNERS[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(tenantId, input || {});
}

module.exports = { TOOLS, runTool };
