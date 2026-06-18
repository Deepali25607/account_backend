const express = require("express");
const db = require("../db");
const { auth, requireFeature, logAction } = require("../middleware");
const { requirePermission } = require("../permissions");
const { wantsPage, pageParams } = require("../paginate");

const router = express.Router();
router.use(auth);

// Item material types (kept in sync with the frontend dropdown in Inventory.jsx).
const MATERIAL_TYPES = ["raw", "semi_finished", "finished", "trading", "consumable", "service"];
const validMaterial = (t) => MATERIAL_TYPES.includes(t);

// SKU prefix per material type — auto-generated SKUs look like FG-00001, RM-00007…
const SKU_PREFIX = {
  raw: "RM", semi_finished: "SF", finished: "FG",
  trading: "TG", consumable: "CM", service: "SV",
};

/** Next free auto-SKU for a material type (e.g. FG-00001), unique within the tenant. */
function nextSku(tenantId, materialType) {
  const prefix = SKU_PREFIX[materialType] || "IT";
  const rows = db.prepare("SELECT sku FROM items WHERE tenant_id=? AND sku LIKE ?").all(tenantId, `${prefix}-%`);
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const r of rows) { const m = re.exec(r.sku); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  let n = max + 1, sku;
  do { sku = `${prefix}-${String(n).padStart(5, "0")}`; n++; }
  while (db.prepare("SELECT 1 FROM items WHERE tenant_id=? AND sku=?").get(tenantId, sku)); // skip manual collisions/gaps
  return sku;
}

/* ───────────────────────── Items / Inventory (IN-01..06) ───────────────────────── */

router.get("/item-material-types", (req, res) => res.json(MATERIAL_TYPES));

/** Resolve a scanned barcode (or exact SKU) to an item — used at sale/purchase entry. */
router.get("/items/lookup", requireFeature("inventory"), (req, res) => {
  const code = String(req.query.code || req.query.barcode || "").trim();
  if (!code) return res.status(400).json({ error: "code is required" });
  const item = db.prepare(
    "SELECT * FROM items WHERE tenant_id=? AND (barcode=? OR sku=?) ORDER BY (barcode=?) DESC LIMIT 1"
  ).get(req.tenant.id, code, code, code);
  if (!item) return res.status(404).json({ error: "No item with that barcode or SKU" });
  res.json(item);
});

router.get("/items", requireFeature("inventory"), (req, res) => {
  const { search, lowStock } = req.query;
  let where = "WHERE tenant_id = ?";
  const params = [req.tenant.id];
  if (search) { where += " AND (name LIKE ? OR sku LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
  if (lowStock === "true") where += " AND stock_qty <= reorder_lvl";

  if (wantsPage(req)) {
    const { page, pageSize, offset } = pageParams(req);
    const total = db.prepare(`SELECT COUNT(*) c FROM items ${where}`).get(...params).c;
    const rows = db.prepare(`SELECT * FROM items ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    return res.json({ rows, total, page, pageSize });
  }
  res.json(db.prepare(`SELECT * FROM items ${where} ORDER BY name`).all(...params));
});

router.post("/items", requireFeature("inventory"), requirePermission("inventory", "create"), (req, res) => {
  const { sku, name, category, material_type, uom, cost_price, sale_price, tax_rate, stock_qty, reorder_lvl, barcode, hsn } =
    req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!material_type || !validMaterial(material_type))
    return res.status(400).json({ error: `material_type is required and must be one of: ${MATERIAL_TYPES.join(", ")}` });
  // SKU is optional — auto-generate from the material type when omitted (e.g. FG-00001).
  const finalSku = (sku ?? "").toString().trim() || nextSku(req.tenant.id, material_type);
  try {
    const r = db
      .prepare(
        `INSERT INTO items (tenant_id, sku, name, category, material_type, uom, cost_price, sale_price, tax_rate, stock_qty, reorder_lvl, barcode, hsn)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        req.tenant.id, finalSku, name, category || null, material_type, uom || "unit",
        num(cost_price), num(sale_price), num(tax_rate), num(stock_qty), num(reorder_lvl), normBarcode(barcode), normText(hsn)
      );
    if (num(stock_qty) !== 0) recordMovement(req.tenant.id, r.lastInsertRowid, num(stock_qty), "opening", "item", r.lastInsertRowid);
    logAction(req, "create", "item", r.lastInsertRowid);
    res.status(201).json(getItem(req.tenant.id, r.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes("UNIQUE"))
      return res.status(409).json({ error: /barcode/i.test(e.message) ? "Barcode already in use by another item" : "SKU already exists" });
    throw e;
  }
});

/**
 * Bulk item import (from the CSV template). Each row is inserted independently:
 * valid rows are created, invalid/duplicate rows are skipped and reported, so a
 * single bad row never aborts the whole import. Body: { items: [ {sku,name,...} ] }.
 */
router.post("/items/bulk", requireFeature("inventory"), requirePermission("inventory", "create"), (req, res) => {
  const list = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!list || !list.length) return res.status(400).json({ error: "items array is required" });
  if (list.length > 1000) return res.status(400).json({ error: "Too many rows — import up to 1000 at a time" });

  const insert = db.prepare(
    `INSERT INTO items (tenant_id, sku, name, category, material_type, uom, cost_price, sale_price, tax_rate, stock_qty, reorder_lvl, barcode, hsn)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const created = [];
  const failed = [];
  list.forEach((raw, idx) => {
    const rowNo = idx + 2; // +1 for 0-index, +1 for the header line
    const sku = (raw.sku ?? "").toString().trim();
    const name = (raw.name ?? "").toString().trim();
    const material_type = (raw.material_type ?? "").toString().trim();
    try {
      if (!name) throw new Error("name is required");
      if (!validMaterial(material_type)) throw new Error(`material_type must be one of: ${MATERIAL_TYPES.join(", ")}`);
      const skuFinal = sku || nextSku(req.tenant.id, material_type); // auto-generate when blank
      const r = insert.run(
        req.tenant.id, skuFinal, name, normText(raw.category), material_type, (raw.uom ?? "").toString().trim() || "unit",
        num(raw.cost_price), num(raw.sale_price), num(raw.tax_rate), num(raw.stock_qty), num(raw.reorder_lvl),
        normBarcode(raw.barcode), normText(raw.hsn)
      );
      if (num(raw.stock_qty) !== 0) recordMovement(req.tenant.id, r.lastInsertRowid, num(raw.stock_qty), "opening", "item", r.lastInsertRowid);
      created.push({ row: rowNo, sku: skuFinal, id: r.lastInsertRowid });
    } catch (e) {
      const m = String(e.message);
      const error = m.includes("UNIQUE")
        ? (/barcode/i.test(m) ? "Barcode already in use" : "SKU already exists")
        : m;
      failed.push({ row: rowNo, sku, error });
    }
  });
  if (created.length) logAction(req, "bulk_create", "item", created.length);
  res.status(created.length ? 201 : 422).json({ total: list.length, created: created.length, failed });
});

router.put("/items/:id", requireFeature("inventory"), requirePermission("inventory", "edit"), (req, res) => {
  const item = getItem(req.tenant.id, req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  const { name, category, material_type, uom, cost_price, sale_price, tax_rate, reorder_lvl, barcode, hsn } = req.body || {};
  if (material_type !== undefined && !validMaterial(material_type))
    return res.status(400).json({ error: `material_type must be one of: ${MATERIAL_TYPES.join(", ")}` });
  try {
    db.prepare(
      `UPDATE items SET name=?, category=?, material_type=?, uom=?, cost_price=?, sale_price=?, tax_rate=?, reorder_lvl=?, barcode=?, hsn=?
       WHERE id=? AND tenant_id=?`
    ).run(
      name ?? item.name, category ?? item.category, material_type ?? item.material_type, uom ?? item.uom,
      num(cost_price ?? item.cost_price), num(sale_price ?? item.sale_price),
      num(tax_rate ?? item.tax_rate), num(reorder_lvl ?? item.reorder_lvl),
      barcode !== undefined ? normBarcode(barcode) : (item.barcode || null),
      hsn !== undefined ? normText(hsn) : (item.hsn || null),
      item.id, req.tenant.id
    );
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Barcode already in use by another item" });
    throw e;
  }
  logAction(req, "update", "item", item.id);
  res.json(getItem(req.tenant.id, item.id));
});

/** Manual stock adjustment with mandatory reason (IN-04). */
router.post("/items/:id/adjust", requireFeature("inventory"), requirePermission("inventory", "edit"), (req, res) => {
  const item = getItem(req.tenant.id, req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  const { qty_delta, reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: "A reason is required for adjustments" });
  if (!num(qty_delta)) return res.status(400).json({ error: "qty_delta must be non-zero" });
  const tx = db.transaction(() => {
    db.prepare("UPDATE items SET stock_qty = stock_qty + ? WHERE id = ?").run(num(qty_delta), item.id);
    recordMovement(req.tenant.id, item.id, num(qty_delta), "adjustment", "item", item.id, reason);
  });
  tx();
  logAction(req, "adjust", "item", item.id);
  res.json(getItem(req.tenant.id, item.id));
});

router.get("/items/:id/movements", requireFeature("inventory"), (req, res) => {
  res.json(
    db.prepare(
      "SELECT * FROM stock_movements WHERE tenant_id=? AND item_id=? ORDER BY created_at DESC, id DESC"
    ).all(req.tenant.id, req.params.id)
  );
});

/** Delete an item (admin CRUD). Blocked if it's referenced by any transaction or
 *  BOM so historical documents are never orphaned; its own stock ledger goes with it. */
router.delete("/items/:id", requireFeature("inventory"), requirePermission("inventory", "delete"), (req, res) => {
  const item = getItem(req.tenant.id, req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  const used = [];
  if (db.prepare("SELECT COUNT(*) c FROM purchase_lines WHERE item_id=?").get(item.id).c) used.push("purchases");
  if (db.prepare("SELECT COUNT(*) c FROM sale_lines WHERE item_id=?").get(item.id).c) used.push("sales");
  if (db.prepare("SELECT COUNT(*) c FROM bom_lines WHERE item_id=?").get(item.id).c) used.push("a BOM component");
  if (db.prepare("SELECT COUNT(*) c FROM boms WHERE item_id=? AND tenant_id=?").get(item.id, req.tenant.id).c) used.push("a BOM output");
  if (used.length)
    return res.status(409).json({ error: `Can't delete “${item.name}” — it's used in ${used.join(", ")}. Keep it for history (you can set stock to 0 instead).` });

  db.transaction(() => {
    db.prepare("DELETE FROM item_location_stock WHERE item_id=? AND tenant_id=?").run(item.id, req.tenant.id);
    db.prepare("DELETE FROM stock_movements WHERE item_id=? AND tenant_id=?").run(item.id, req.tenant.id);
    db.prepare("DELETE FROM items WHERE id=? AND tenant_id=?").run(item.id, req.tenant.id);
  })();
  logAction(req, "delete", "item", item.id);
  res.json({ ok: true, id: item.id });
});

/* ───────────────────────── Vendors (PU-02) & Customers (SA-02) ───────────────────────── */

function masterRoutes(table, feature) {
  router.get(`/${table}`, requireFeature(feature), (req, res) => {
    res.json(db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? ORDER BY name`).all(req.tenant.id));
  });
  router.post(`/${table}`, requireFeature(feature), (req, res) => {
    const { name, email, phone, tax_no, payment_terms } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    const r = db
      .prepare(`INSERT INTO ${table} (tenant_id, name, email, phone, tax_no, payment_terms) VALUES (?,?,?,?,?,?)`)
      .run(req.tenant.id, name, email || null, phone || null, tax_no || null, payment_terms || null);
    logAction(req, "create", table, r.lastInsertRowid);
    res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(r.lastInsertRowid));
  });

  // Edit (full CRUD)
  router.put(`/${table}/:id`, requireFeature(feature), (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`).get(req.params.id, req.tenant.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const { name, email, phone, tax_no, payment_terms } = req.body || {};
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: "name cannot be empty" });
    db.prepare(`UPDATE ${table} SET name=?, email=?, phone=?, tax_no=?, payment_terms=? WHERE id=? AND tenant_id=?`)
      .run(name ?? row.name, email ?? row.email, phone ?? row.phone, tax_no ?? row.tax_no, payment_terms ?? row.payment_terms, row.id, req.tenant.id);
    logAction(req, "update", table, row.id);
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id));
  });

  // Delete (full CRUD) — blocked if the party has documents on record.
  router.delete(`/${table}/:id`, requireFeature(feature), (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`).get(req.params.id, req.tenant.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const docTable = table === "vendors" ? "purchases" : "sales";
    const fk = table === "vendors" ? "vendor_id" : "customer_id";
    const n = db.prepare(`SELECT COUNT(*) c FROM ${docTable} WHERE ${fk}=? AND tenant_id=?`).get(row.id, req.tenant.id).c;
    if (n) return res.status(409).json({ error: `Can't delete “${row.name}” — ${n} ${docTable} reference it. Keep the record for history.` });
    db.prepare(`DELETE FROM ${table} WHERE id=? AND tenant_id=?`).run(row.id, req.tenant.id);
    logAction(req, "delete", table, row.id);
    res.json({ ok: true, id: row.id });
  });
}
masterRoutes("vendors", "purchases");
masterRoutes("customers", "sales");

/* ───────────────────────── helpers ───────────────────────── */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function normBarcode(v) {
  const s = (v ?? "").toString().trim();
  return s || null; // store NULL (not "") so the partial unique index ignores blanks
}
function normText(v) {
  const s = (v ?? "").toString().trim();
  return s || null;
}
function getItem(tenantId, id) {
  return db.prepare("SELECT * FROM items WHERE id=? AND tenant_id=?").get(id, tenantId);
}
function recordMovement(tenantId, itemId, delta, reason, refType, refId, note) {
  db.prepare(
    "INSERT INTO stock_movements (tenant_id, item_id, qty_delta, reason, ref_type, ref_id, note) VALUES (?,?,?,?,?,?,?)"
  ).run(tenantId, itemId, delta, reason, refType || null, refId || null, note || null);
}

module.exports = router;
module.exports.recordMovement = recordMovement;
module.exports.num = num;
