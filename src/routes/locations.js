const express = require("express");
const db = require("../db");
const { auth, requireFeature, logAction } = require("../middleware");
const { recordMovement } = require("./masters");
const { ensureDefaultLocation, isDefault, qtyAt, adjustNamed, stockByLocation, round } = require("../locations");

const router = express.Router();
router.use(auth);
router.use(requireFeature("multi_location")); // Premium only (§5.2, IN-06)
router.use((req, res, next) => { ensureDefaultLocation(req.tenant.id); next(); });

/** List warehouses (Main first). */
router.get("/", (req, res) => {
  res.json(db.prepare("SELECT * FROM locations WHERE tenant_id=? ORDER BY is_default DESC, name").all(req.tenant.id));
});

/** Create a warehouse. */
router.post("/", (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const r = db.prepare("INSERT INTO locations (tenant_id, name, is_default) VALUES (?,?,0)").run(req.tenant.id, name);
  logAction(req, "create", "location", r.lastInsertRowid);
  res.status(201).json(db.prepare("SELECT * FROM locations WHERE id=?").get(r.lastInsertRowid));
});

/** Rename a warehouse. */
router.patch("/:id", (req, res) => {
  const loc = db.prepare("SELECT * FROM locations WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!loc) return res.status(404).json({ error: "Not found" });
  if (req.body?.name) db.prepare("UPDATE locations SET name=? WHERE id=?").run(req.body.name, loc.id);
  res.json(db.prepare("SELECT * FROM locations WHERE id=?").get(loc.id));
});

/** Delete an empty, non-default warehouse. */
router.delete("/:id", (req, res) => {
  const loc = db.prepare("SELECT * FROM locations WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!loc) return res.status(404).json({ error: "Not found" });
  if (loc.is_default) return res.status(400).json({ error: "Cannot delete the default location" });
  const held = db.prepare("SELECT COALESCE(SUM(qty),0) s FROM item_location_stock WHERE location_id=?").get(loc.id).s;
  if (round(held) !== 0) return res.status(409).json({ error: "Move out all stock before deleting this warehouse" });
  db.prepare("DELETE FROM item_location_stock WHERE location_id=?").run(loc.id);
  db.prepare("DELETE FROM locations WHERE id=?").run(loc.id);
  res.json({ ok: true });
});

/** Per-item stock across all locations. */
router.get("/stock", (req, res) => {
  res.json({
    locations: db.prepare("SELECT id, name, is_default FROM locations WHERE tenant_id=? ORDER BY is_default DESC, name").all(req.tenant.id),
    items: stockByLocation(req.tenant.id),
  });
});

/** Transfer stock between two locations (either side may be Main). */
router.post("/transfer", (req, res) => {
  const { item_id, from_location_id, to_location_id, qty } = req.body || {};
  const q = round(Number(qty));
  if (!item_id || !from_location_id || !to_location_id) return res.status(400).json({ error: "item_id, from_location_id, to_location_id are required" });
  if (Number(from_location_id) === Number(to_location_id)) return res.status(400).json({ error: "Source and destination must differ" });
  if (!(q > 0)) return res.status(400).json({ error: "qty must be positive" });

  const item = db.prepare("SELECT * FROM items WHERE id=? AND tenant_id=?").get(item_id, req.tenant.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  for (const id of [from_location_id, to_location_id])
    if (!db.prepare("SELECT id FROM locations WHERE id=? AND tenant_id=?").get(id, req.tenant.id))
      return res.status(400).json({ error: "Unknown location" });

  const avail = qtyAt(req.tenant.id, item_id, from_location_id);
  if (q > avail) return res.status(409).json({ error: `Only ${avail} ${item.uom} available at the source location` });

  db.transaction(() => {
    adjustNamed(req.tenant.id, item_id, from_location_id, -q); // no-op if Main
    adjustNamed(req.tenant.id, item_id, to_location_id, q);    // no-op if Main
    // total (items.stock_qty) is unchanged by a transfer; record audit movements
    recordMovement(req.tenant.id, item_id, -q, "transfer_out", "location", from_location_id);
    recordMovement(req.tenant.id, item_id, q, "transfer_in", "location", to_location_id);
  })();
  logAction(req, "transfer", "item", item_id);
  res.json({ ok: true });
});

module.exports = router;
