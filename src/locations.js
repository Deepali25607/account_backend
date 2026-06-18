/**
 * IN-06 multi-location stock (Premium). Model: items.stock_qty stays the
 * authoritative total. Named (non-default) warehouses store their qty in
 * item_location_stock. The default "Main Store" balance is *computed* as
 * total − Σ(named), so the aggregate is never double-counted and all existing
 * reports/valuation keep working unchanged.
 */
const db = require("./db");

function ensureDefaultLocation(tenantId) {
  let loc = db.prepare("SELECT * FROM locations WHERE tenant_id=? AND is_default=1").get(tenantId);
  if (!loc) {
    const r = db.prepare("INSERT INTO locations (tenant_id, name, is_default) VALUES (?, 'Main Store', 1)").run(tenantId);
    loc = db.prepare("SELECT * FROM locations WHERE id=?").get(r.lastInsertRowid);
  }
  return loc;
}

const isDefault = (tenantId, locationId) =>
  !!db.prepare("SELECT is_default FROM locations WHERE id=? AND tenant_id=?").get(locationId, tenantId)?.is_default;

/** Σ qty held in named (non-default) locations for an item. */
function namedSum(tenantId, itemId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(ils.qty),0) s FROM item_location_stock ils
     JOIN locations l ON l.id=ils.location_id
     WHERE ils.tenant_id=? AND ils.item_id=? AND l.is_default=0`
  ).get(tenantId, itemId);
  return round(row.s);
}

/** Qty available at a given location (computed for the default Main). */
function qtyAt(tenantId, itemId, locationId) {
  if (isDefault(tenantId, locationId)) {
    const total = db.prepare("SELECT stock_qty q FROM items WHERE id=? AND tenant_id=?").get(itemId, tenantId)?.q ?? 0;
    return round(total - namedSum(tenantId, itemId));
  }
  const row = db.prepare("SELECT qty FROM item_location_stock WHERE item_id=? AND location_id=?").get(itemId, locationId);
  return round(row?.qty ?? 0);
}

/** Adjust a NAMED location's stored qty by delta (no-op for the default Main). */
function adjustNamed(tenantId, itemId, locationId, delta) {
  if (!locationId || isDefault(tenantId, locationId) || !delta) return;
  const existing = db.prepare("SELECT id, qty FROM item_location_stock WHERE item_id=? AND location_id=?").get(itemId, locationId);
  if (existing) db.prepare("UPDATE item_location_stock SET qty=? WHERE id=?").run(round(existing.qty + delta), existing.id);
  else db.prepare("INSERT INTO item_location_stock (tenant_id, item_id, location_id, qty) VALUES (?,?,?,?)").run(tenantId, itemId, locationId, round(delta));
}

/** Per-item breakdown across Main + named locations. */
function stockByLocation(tenantId) {
  const locations = db.prepare("SELECT * FROM locations WHERE tenant_id=? ORDER BY is_default DESC, name").all(tenantId);
  const items = db.prepare("SELECT id, sku, name, uom, stock_qty FROM items WHERE tenant_id=? ORDER BY name").all(tenantId);
  return items.map((it) => {
    const named = db.prepare(
      `SELECT location_id, qty FROM item_location_stock WHERE item_id=? AND qty<>0`
    ).all(it.id);
    const namedMap = Object.fromEntries(named.map((n) => [n.location_id, n.qty]));
    const byLocation = locations.map((l) => ({
      location_id: l.id, location: l.name, is_default: !!l.is_default,
      qty: l.is_default ? round(it.stock_qty - namedSum(tenantId, it.id)) : round(namedMap[l.id] ?? 0),
    }));
    return { item_id: it.id, sku: it.sku, name: it.name, uom: it.uom, total: it.stock_qty, byLocation };
  });
}

function round(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 1000) / 1000; }

module.exports = { ensureDefaultLocation, isDefault, namedSum, qtyAt, adjustNamed, stockByLocation, round };
