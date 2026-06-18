const express = require("express");
const db = require("../db");
const { auth, requireFeature, logAction } = require("../middleware");
const { recordMovement } = require("./masters");
const { getItem, bomForItem, rollupCost, runMrp, round } = require("../manufacturing");

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
    b.rolled_cost = rollupCost(req.tenant.id, b.item_id);
  }
  res.json(boms);
});

router.post("/boms", (req, res) => {
  const { item_id, name, output_qty, std_cost, lines } = req.body || {};
  if (!item_id || !name) return res.status(400).json({ error: "item_id and name are required" });
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: "At least one component is required" });
  if (lines.some((l) => Number(l.item_id) === Number(item_id)))
    return res.status(400).json({ error: "A BOM cannot include its own output item as a component" });
  if (db.prepare("SELECT id FROM boms WHERE tenant_id=? AND item_id=?").get(req.tenant.id, item_id))
    return res.status(409).json({ error: "This item already has a BOM" });

  // Material type drives manufacturability: only Finished/Semi-Finished items are produced.
  const output = getItem(req.tenant.id, item_id);
  if (!output) return res.status(400).json({ error: "Output item not found" });
  if (!["finished", "semi_finished"].includes(output.material_type))
    return res.status(400).json({ error: "Only Finished or Semi-Finished items can have a BOM (set the item's Material Type)" });
  for (const l of lines) {
    const comp = getItem(req.tenant.id, l.item_id);
    if (comp && comp.material_type === "service")
      return res.status(400).json({ error: `Service items (${comp.name}) cannot be BOM components` });
  }

  const id = db.transaction(() => {
    const b = db.prepare("INSERT INTO boms (tenant_id, item_id, name, output_qty, std_cost) VALUES (?,?,?,?,?)")
      .run(req.tenant.id, item_id, name, Number(output_qty) || 1, Number(std_cost) || 0);
    const ins = db.prepare("INSERT INTO bom_lines (bom_id, item_id, qty) VALUES (?,?,?)");
    for (const l of lines) if (l.item_id && Number(l.qty) > 0) ins.run(b.lastInsertRowid, l.item_id, Number(l.qty));
    db.prepare("UPDATE items SET is_manufactured=1 WHERE id=? AND tenant_id=?").run(item_id, req.tenant.id);
    return b.lastInsertRowid;
  })();
  logAction(req, "create", "bom", id);
  res.status(201).json(bomForItem(req.tenant.id, item_id));
});

router.delete("/boms/:id", (req, res) => {
  const bom = db.prepare("SELECT * FROM boms WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!bom) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM boms WHERE id=?").run(bom.id);
  db.prepare("UPDATE items SET is_manufactured=0 WHERE id=?").run(bom.item_id);
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
    const fg = getItem(req.tenant.id, bom.item_id);
    const unitCost = qty > 0 ? componentCost / qty : fg.cost_price;
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
    const subtotal = round(shortages.reduce((s, x) => s + x.net * x.cost_price, 0));
    const docNo = `PO-DRAFT-${Date.now().toString().slice(-6)}`;
    const p = db.prepare(
      `INSERT INTO purchases (tenant_id, vendor_id, doc_no, doc_type, status, subtotal, tax_total, grand_total, notes)
       VALUES (?,?,?,'purchase','draft',?,0,?,?)`
    ).run(req.tenant.id, vendor_id, docNo, subtotal, subtotal, `Auto-generated from MRP for production order #${po.id}`);
    const ins = db.prepare("INSERT INTO purchase_lines (purchase_id, item_id, qty, unit_price, tax_rate, line_total) VALUES (?,?,?,?,?,?)");
    for (const s of shortages) ins.run(p.lastInsertRowid, s.item_id, s.net, s.cost_price, 0, round(s.net * s.cost_price));
    return p.lastInsertRowid;
  })();
  logAction(req, "create", "draft_po", id);
  res.status(201).json(db.prepare("SELECT * FROM purchases WHERE id=?").get(id));
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
