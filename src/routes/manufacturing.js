const express = require("express");
const db = require("../db");
const { auth, requireFeature, logAction } = require("../middleware");
const { recordMovement } = require("./masters");
const { getItem, bomForItem, expenseTotal, rollupCost, runMrp, round } = require("../manufacturing");

const router = express.Router();
router.use(auth);
router.use(requireFeature("manufacturing")); // Premium only (§5.2)

/* ───────────────────────── BOMs (MF-01, MF-02, MF-09) ───────────────────────── */

router.get("/boms", (req, res) => {
  const boms = db.prepare(
    `SELECT b.*, i.name AS item_name, i.sku FROM boms b JOIN items i ON i.id=b.item_id WHERE b.tenant_id=? ORDER BY b.id DESC`
  ).all(req.tenant.id);
  for (const b of boms) {
    b.lines = db.prepare(
      `SELECT bl.*, i.name AS item_name, i.sku FROM bom_lines bl JOIN items i ON i.id=bl.item_id WHERE bl.bom_id=?`
    ).all(b.id);
    b.expenses = db.prepare("SELECT * FROM bom_expenses WHERE bom_id=?").all(b.id);
    b.rolled_cost = rollupCost(req.tenant.id, b.item_id);
  }
  res.json(boms);
});

/**
 * Additional expenses (labour, electricity, packaging…) — optional, per build batch.
 * 'fixed' rows carry an amount; 'labour' rows derive it from the employee's
 * monthly salary and working hours: salary / monthly_hours * hours_used.
 * Returns { rows } or { error }.
 */
function parseExpenseRows(expenses) {
  const rows = (Array.isArray(expenses) ? expenses : [])
    .map((e) => ({
      basis: e?.basis === "labour" ? "labour" : "fixed",
      name: (e?.name ?? "").toString().trim(),
      amount: Number(e?.amount),
      monthly_salary: Number(e?.monthly_salary),
      monthly_hours: Number(e?.monthly_hours),
      hours_used: Number(e?.hours_used),
    }))
    .filter((e) => e.name || e.amount || e.monthly_salary || e.hours_used); // ignore fully blank rows
  for (const e of rows) {
    if (!e.name) return { error: "Each additional expense needs a name" };
    if (e.basis === "labour") {
      if (!(e.monthly_salary > 0)) return { error: `Labour expense "${e.name}" needs a positive monthly salary` };
      if (!(e.monthly_hours > 0)) return { error: `Labour expense "${e.name}" needs the monthly working hours` };
      if (!(e.hours_used > 0)) return { error: `Labour expense "${e.name}" needs the hours consumed per build` };
      e.amount = round(e.monthly_salary / e.monthly_hours * e.hours_used);
    } else {
      if (!(e.amount > 0)) return { error: `Additional expense "${e.name}" needs a positive amount` };
      e.monthly_salary = e.monthly_hours = e.hours_used = null;
    }
  }
  return { rows };
}

/** Shared create/update validation of the output item and component lines. */
function validateBomShape(tenantId, item_id, name, lines) {
  if (!item_id || !name) return "item_id and name are required";
  if (!Array.isArray(lines) || !lines.length) return "At least one component is required";
  if (lines.some((l) => Number(l.item_id) === Number(item_id)))
    return "A BOM cannot include its own output item as a component";
  // Material type drives manufacturability: only Finished/Semi-Finished items are produced.
  const output = getItem(tenantId, item_id);
  if (!output) return "Output item not found";
  if (!["finished", "semi_finished"].includes(output.material_type))
    return "Only Finished or Semi-Finished items can have a BOM (set the item's Material Type)";
  for (const l of lines) {
    const comp = getItem(tenantId, l.item_id);
    if (comp && comp.material_type === "service") return `Service items (${comp.name}) cannot be BOM components`;
  }
  return null;
}

router.post("/boms", (req, res) => {
  const { item_id, name, output_qty, std_cost, lines, expenses } = req.body || {};
  const shapeErr = validateBomShape(req.tenant.id, item_id, name, lines);
  if (shapeErr) return res.status(400).json({ error: shapeErr });
  const exp = parseExpenseRows(expenses);
  if (exp.error) return res.status(400).json({ error: exp.error });
  const expRows = exp.rows;
  if (db.prepare("SELECT id FROM boms WHERE tenant_id=? AND item_id=?").get(req.tenant.id, item_id))
    return res.status(409).json({ error: "This item already has a BOM" });

  const id = db.transaction(() => {
    const b = db.prepare("INSERT INTO boms (tenant_id, item_id, name, output_qty, std_cost) VALUES (?,?,?,?,?)")
      .run(req.tenant.id, item_id, name, Number(output_qty) || 1, Number(std_cost) || 0);
    const ins = db.prepare("INSERT INTO bom_lines (bom_id, item_id, qty) VALUES (?,?,?)");
    for (const l of lines) if (l.item_id && Number(l.qty) > 0) ins.run(b.lastInsertRowid, l.item_id, Number(l.qty));
    const insExp = db.prepare(
      "INSERT INTO bom_expenses (bom_id, name, basis, monthly_salary, monthly_hours, hours_used, amount) VALUES (?,?,?,?,?,?,?)"
    );
    for (const e of expRows) insExp.run(b.lastInsertRowid, e.name, e.basis, e.monthly_salary, e.monthly_hours, e.hours_used, e.amount);
    db.prepare("UPDATE items SET is_manufactured=1 WHERE id=? AND tenant_id=?").run(item_id, req.tenant.id);
    return b.lastInsertRowid;
  })();
  logAction(req, "create", "bom", id);
  res.status(201).json(bomForItem(req.tenant.id, item_id));
});

/**
 * MF-02: edit a BOM. Lines and expenses are replaced wholesale. Editing only
 * affects future cost rollups and completions — costs already absorbed into
 * finished goods by past production runs are not restated.
 */
router.put("/boms/:id", (req, res) => {
  const bom = db.prepare("SELECT * FROM boms WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!bom) return res.status(404).json({ error: "Not found" });
  const { item_id, name, output_qty, std_cost, lines, expenses } = req.body || {};
  const outId = Number(item_id) || bom.item_id;
  const shapeErr = validateBomShape(req.tenant.id, outId, name, lines);
  if (shapeErr) return res.status(400).json({ error: shapeErr });
  const exp = parseExpenseRows(expenses);
  if (exp.error) return res.status(400).json({ error: exp.error });
  if (outId !== bom.item_id && db.prepare("SELECT id FROM boms WHERE tenant_id=? AND item_id=?").get(req.tenant.id, outId))
    return res.status(409).json({ error: "That item already has a BOM" });

  db.transaction(() => {
    db.prepare("UPDATE boms SET item_id=?, name=?, output_qty=?, std_cost=? WHERE id=?")
      .run(outId, name, Number(output_qty) || 1, Number(std_cost) || 0, bom.id);
    db.prepare("DELETE FROM bom_lines WHERE bom_id=?").run(bom.id);
    db.prepare("DELETE FROM bom_expenses WHERE bom_id=?").run(bom.id);
    const ins = db.prepare("INSERT INTO bom_lines (bom_id, item_id, qty) VALUES (?,?,?)");
    for (const l of lines) if (l.item_id && Number(l.qty) > 0) ins.run(bom.id, l.item_id, Number(l.qty));
    const insExp = db.prepare(
      "INSERT INTO bom_expenses (bom_id, name, basis, monthly_salary, monthly_hours, hours_used, amount) VALUES (?,?,?,?,?,?,?)"
    );
    for (const e of exp.rows) insExp.run(bom.id, e.name, e.basis, e.monthly_salary, e.monthly_hours, e.hours_used, e.amount);
    if (outId !== bom.item_id) {
      db.prepare("UPDATE items SET is_manufactured=0 WHERE id=? AND tenant_id=?").run(bom.item_id, req.tenant.id);
      db.prepare("UPDATE items SET is_manufactured=1 WHERE id=? AND tenant_id=?").run(outId, req.tenant.id);
    }
  })();
  logAction(req, "update", "bom", bom.id);
  res.json(bomForItem(req.tenant.id, outId));
});

/**
 * Delete a BOM. Blocked while orders are open or once any order has produced
 * stock with it (history is never orphaned — same policy as item deletion).
 * Abandoned orders (closed, nothing produced) are removed along with the BOM.
 */
router.delete("/boms/:id", (req, res) => {
  const bom = db.prepare("SELECT * FROM boms WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!bom) return res.status(404).json({ error: "Not found" });
  const open = db.prepare("SELECT COUNT(*) c FROM production_orders WHERE bom_id=? AND status IN ('planned','in_progress')").get(bom.id).c;
  if (open)
    return res.status(409).json({ error: `Can't delete this BOM — ${open} production order(s) are planned or in progress. Complete or close them first.` });
  const produced = db.prepare("SELECT COUNT(*) c FROM production_orders WHERE bom_id=? AND completed_qty > 0").get(bom.id).c;
  if (produced)
    return res.status(409).json({ error: `Can't delete this BOM — ${produced} production order(s) already produced stock with it, so it's kept for history.` });
  db.transaction(() => {
    db.prepare("DELETE FROM production_orders WHERE bom_id=?").run(bom.id); // only closed, zero-progress orders remain here
    db.prepare("DELETE FROM boms WHERE id=?").run(bom.id); // lines & expenses cascade
    db.prepare("UPDATE items SET is_manufactured=0 WHERE id=? AND tenant_id=?").run(bom.item_id, req.tenant.id);
  })();
  logAction(req, "delete", "bom", bom.id);
  res.json({ ok: true });
});

/* ───────────────────────── Production orders (MF-03, MF-06, MF-07) ───────────────────────── */

router.get("/production-orders", (req, res) => {
  res.json(db.prepare(
    `SELECT po.*, i.name AS item_name, i.sku, b.name AS bom_name, b.output_qty
     FROM production_orders po JOIN boms b ON b.id=po.bom_id JOIN items i ON i.id=b.item_id
     WHERE po.tenant_id=? ORDER BY po.id DESC`
  ).all(req.tenant.id));
});

router.post("/production-orders", (req, res) => {
  const { bom_id, qty, planned_date } = req.body || {};
  const bom = db.prepare("SELECT * FROM boms WHERE id=? AND tenant_id=?").get(bom_id, req.tenant.id);
  if (!bom) return res.status(400).json({ error: "Valid bom_id required" });
  if (!(Number(qty) > 0)) return res.status(400).json({ error: "qty must be positive" });
  const r = db.prepare("INSERT INTO production_orders (tenant_id, bom_id, qty, planned_date, status) VALUES (?,?,?,?,'planned')")
    .run(req.tenant.id, bom_id, Number(qty), planned_date || null);
  logAction(req, "create", "production_order", r.lastInsertRowid);
  res.status(201).json(db.prepare("SELECT * FROM production_orders WHERE id=?").get(r.lastInsertRowid));
});

/** MF-06 status transitions (start / close). Completion uses /complete below. */
router.patch("/production-orders/:id/status", (req, res) => {
  const po = db.prepare("SELECT * FROM production_orders WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!po) return res.status(404).json({ error: "Not found" });
  const { status } = req.body || {};
  if (!["planned", "in_progress", "closed"].includes(status))
    return res.status(400).json({ error: "Use POST /complete to complete an order" });
  db.prepare("UPDATE production_orders SET status=? WHERE id=?").run(status, po.id);
  res.json(db.prepare("SELECT * FROM production_orders WHERE id=?").get(po.id));
});

/**
 * MF-07 completion, supporting partial (WIP) completion. Consumes components for
 * the completed quantity and adds finished goods; blocked if components are short.
 * Body: { qty } — defaults to the full remaining quantity.
 */
router.post("/production-orders/:id/complete", (req, res) => {
  const po = db.prepare("SELECT * FROM production_orders WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!po) return res.status(404).json({ error: "Not found" });
  if (!["planned", "in_progress"].includes(po.status))
    return res.status(409).json({ error: `Cannot complete an order that is '${po.status}'` });
  const remaining = round(po.qty - po.completed_qty);
  const qty = req.body?.qty === undefined ? remaining : round(Number(req.body.qty));
  if (!(qty > 0)) return res.status(400).json({ error: "qty must be positive" });
  if (qty > remaining) return res.status(400).json({ error: `Only ${remaining} unit(s) remain to complete` });

  const bom = bomForItem(req.tenant.id, db.prepare("SELECT item_id FROM boms WHERE id=?").get(po.bom_id).item_id);
  const reqs = bom.lines.map((l) => ({ ...l, need: round(l.qty * qty / (bom.output_qty || 1)) }));
  const short = reqs.filter((r) => (getItem(req.tenant.id, r.item_id)?.stock_qty ?? 0) < r.need)
    .map((r) => ({ item: r.item_name, need: r.need, have: getItem(req.tenant.id, r.item_id).stock_qty }));
  if (short.length) return res.status(409).json({ error: "Insufficient component stock", shortfalls: short });

  db.transaction(() => {
    let componentCost = 0;
    for (const r of reqs) {
      const comp = getItem(req.tenant.id, r.item_id);
      componentCost += comp.cost_price * r.need;
      db.prepare("UPDATE items SET stock_qty = stock_qty - ? WHERE id=?").run(r.need, r.item_id);
      recordMovement(req.tenant.id, r.item_id, -r.need, "production_consume", "production_order", po.id);
    }
    // Overhead (labour, electricity…) scales with the produced share of a build batch.
    const expenseCost = expenseTotal(bom) * qty / (bom.output_qty || 1);
    const fg = getItem(req.tenant.id, bom.item_id);
    const unitCost = qty > 0 ? (componentCost + expenseCost) / qty : fg.cost_price;
    const newQty = fg.stock_qty + qty;
    const newCost = newQty > 0 ? (fg.stock_qty * fg.cost_price + qty * unitCost) / newQty : unitCost;
    db.prepare("UPDATE items SET stock_qty=?, cost_price=? WHERE id=?").run(round(newQty), round(newCost), fg.id);
    recordMovement(req.tenant.id, fg.id, qty, "production_output", "production_order", po.id);
    const done = round(po.completed_qty + qty);
    db.prepare("UPDATE production_orders SET completed_qty=?, status=? WHERE id=?")
      .run(done, done >= po.qty ? "completed" : "in_progress", po.id);
  })();
  logAction(req, "complete", "production_order", po.id);
  res.json(db.prepare("SELECT * FROM production_orders WHERE id=?").get(po.id));
});

/* ───────────────────────── MRP (MF-04, MF-05) ───────────────────────── */

/** Run MRP for one planned production order. */
router.get("/production-orders/:id/mrp", (req, res) => {
  const po = db.prepare("SELECT * FROM production_orders WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!po) return res.status(404).json({ error: "Not found" });
  const bomItem = db.prepare("SELECT item_id FROM boms WHERE id=?").get(po.bom_id).item_id;
  const bom = bomForItem(req.tenant.id, bomItem);
  res.json(runMrp(req.tenant.id, [{ bom, qty: po.qty }]));
});

/** MF-05: turn purchase shortages from an order's MRP into ONE draft PO for review. */
router.post("/production-orders/:id/draft-po", (req, res) => {
  const po = db.prepare("SELECT * FROM production_orders WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!po) return res.status(404).json({ error: "Not found" });
  const { vendor_id } = req.body || {};
  if (!vendor_id) return res.status(400).json({ error: "vendor_id is required" });
  const bomItem = db.prepare("SELECT item_id FROM boms WHERE id=?").get(po.bom_id).item_id;
  const mrp = runMrp(req.tenant.id, [{ bom: bomForItem(req.tenant.id, bomItem), qty: po.qty }]);
  const shortages = mrp.purchase.filter((p) => p.net > 0);
  if (!shortages.length) return res.status(400).json({ error: "No purchase shortages — nothing to order" });

  const id = db.transaction(() => {
    // Tax per line comes from the item master (GST %), same as manual purchases.
    const taxRateOf = (itemId) => {
      const it = db.prepare("SELECT tax_rate FROM items WHERE id=? AND tenant_id=?").get(itemId, req.tenant.id);
      return it ? Number(it.tax_rate) || 0 : 0;
    };
    const rows = shortages.map((s) => {
      const base = s.net * s.cost_price;
      const taxRate = taxRateOf(s.item_id);
      const lineTax = round(base * taxRate / 100);
      return { item_id: s.item_id, qty: s.net, unit_price: s.cost_price, tax_rate: taxRate, line_total: round(base + lineTax), base, lineTax };
    });
    const subtotal = round(rows.reduce((acc, r) => acc + r.base, 0));
    const taxTotal = round(rows.reduce((acc, r) => acc + r.lineTax, 0));
    const grand = round(subtotal + taxTotal);
    const docNo = `PO-DRAFT-${Date.now().toString().slice(-6)}`;
    const p = db.prepare(
      `INSERT INTO purchases (tenant_id, vendor_id, doc_no, doc_type, status, subtotal, tax_total, grand_total, notes)
       VALUES (?,?,?,'purchase','draft',?,?,?,?)`
    ).run(req.tenant.id, vendor_id, docNo, subtotal, taxTotal, grand, `Auto-generated from MRP for production order #${po.id}`);
    const ins = db.prepare("INSERT INTO purchase_lines (purchase_id, item_id, qty, unit_price, tax_rate, line_total) VALUES (?,?,?,?,?,?)");
    for (const r of rows) ins.run(p.lastInsertRowid, r.item_id, r.qty, r.unit_price, r.tax_rate, r.line_total);
    return p.lastInsertRowid;
  })();
  logAction(req, "create", "draft_po", id);
  res.status(201).json(db.prepare("SELECT * FROM purchases WHERE id=?").get(id));
});

/**
 * Sales-enquiry requirement calculator. Body: { demands: [{item_id, qty}] }.
 * Explodes the demanded finished goods through their BOMs (multi-level, netting
 * current stock at every level, same engine as MRP) and returns what to
 * produce, what raw material to arrange, and the labour time needed — derived
 * from each BOM's labour expense rows (hours per build × builds required).
 */
router.post("/requirements", (req, res) => {
  const demands = Array.isArray(req.body?.demands) ? req.body.demands : [];
  const clean = [];
  for (const d of demands) {
    const item = getItem(req.tenant.id, d?.item_id);
    if (!item) return res.status(400).json({ error: "Unknown item in the demand list" });
    if (!(Number(d.qty) > 0)) return res.status(400).json({ error: `Quantity for ${item.name} must be positive` });
    clean.push({ item, qty: Number(d.qty) });
  }
  if (!clean.length) return res.status(400).json({ error: "Add at least one item with a quantity" });

  // Seed the MRP engine with the demand itself via a pseudo-BOM so the demanded
  // goods are netted against stock and exploded exactly like sub-assemblies.
  const pseudo = { output_qty: 1, lines: clean.map((c) => ({ item_id: c.item.id, qty: c.qty })) };
  const mrp = runMrp(req.tenant.id, [{ bom: pseudo, qty: 1 }]);

  let totalHours = 0, totalLabourCost = 0, totalOtherCost = 0;
  const produce = mrp.produce.map((p) => {
    const bom = bomForItem(req.tenant.id, p.item_id);
    const builds = bom && p.net > 0 ? p.net / (bom.output_qty || 1) : 0;
    const labour = (bom?.expenses || [])
      .filter((e) => e.basis === "labour")
      .map((e) => ({ name: e.name, hours: round((e.hours_used || 0) * builds), cost: round(e.amount * builds) }));
    const labour_hours = round(labour.reduce((s, l) => s + l.hours, 0));
    const labour_cost = round(labour.reduce((s, l) => s + l.cost, 0));
    const other_expense_cost = round((bom?.expenses || []).filter((e) => e.basis !== "labour").reduce((s, e) => s + e.amount * builds, 0));
    totalHours = round(totalHours + labour_hours);
    totalLabourCost = round(totalLabourCost + labour_cost);
    totalOtherCost = round(totalOtherCost + other_expense_cost);
    return { ...p, output_qty: bom?.output_qty || 1, builds: round(builds), labour_hours, labour_cost, other_expense_cost, labour };
  });
  // Anything demanded or exploded that has no BOM lands here — it must be bought.
  const purchase = mrp.purchase.map((p) => ({ ...p, est_cost: round(p.net * p.cost_price) }));
  res.json({
    produce, purchase,
    total_hours: totalHours,
    total_labour_cost: totalLabourCost,
    total_other_expense_cost: totalOtherCost,
    purchase_cost: round(purchase.reduce((s, p) => s + p.est_cost, 0)),
  });
});

/* ───────────────────────── Reports (MF-08) ───────────────────────── */

/** BOM cost rollup vs standard cost (variance). */
router.get("/reports/bom-cost", (req, res) => {
  const boms = db.prepare(
    `SELECT b.id, b.name, b.std_cost, i.name AS item_name FROM boms b JOIN items i ON i.id=b.item_id WHERE b.tenant_id=?`
  ).all(req.tenant.id);
  res.json(boms.map((b) => {
    const rolled = rollupCost(req.tenant.id, db.prepare("SELECT item_id FROM boms WHERE id=?").get(b.id).item_id);
    return { ...b, rolled_cost: rolled, variance: round(rolled - b.std_cost) };
  }));
});

/** MRP exception report: net shortages across ALL planned orders (shared stock pool). */
router.get("/reports/shortages", (req, res) => {
  const planned = db.prepare("SELECT * FROM production_orders WHERE tenant_id=? AND status IN ('planned','in_progress')").all(req.tenant.id);
  const orders = planned.map((po) => ({
    bom: bomForItem(req.tenant.id, db.prepare("SELECT item_id FROM boms WHERE id=?").get(po.bom_id).item_id),
    qty: po.qty,
  }));
  const mrp = runMrp(req.tenant.id, orders);
  res.json({
    plannedOrders: planned.length,
    shortages: mrp.purchase.filter((p) => p.net > 0),
    subAssemblies: mrp.produce.filter((p) => p.net > 0),
  });
});

module.exports = router;
