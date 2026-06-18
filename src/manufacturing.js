/**
 * Premium manufacturing engine — BRD §6.7.
 * Pure functions (BOM lookup, cost rollup, MRP explosion) used by the routes.
 */
const db = require("./db");

const getItem = (t, id) => db.prepare("SELECT * FROM items WHERE id=? AND tenant_id=?").get(id, t);

/** BOM (with lines) that produces a given output item, or null if purchased. */
function bomForItem(tenantId, itemId) {
  const bom = db.prepare("SELECT * FROM boms WHERE tenant_id=? AND item_id=?").get(tenantId, itemId);
  if (!bom) return null;
  bom.lines = db.prepare(
    `SELECT bl.*, i.name AS item_name, i.sku, i.cost_price FROM bom_lines bl JOIN items i ON i.id=bl.item_id WHERE bl.bom_id=?`
  ).all(bom.id);
  return bom;
}

/** MF-09: rolled-up cost to produce one output unit (recurses through sub-assemblies). */
function rollupCost(tenantId, itemId, depth = 0) {
  const bom = bomForItem(tenantId, itemId);
  if (!bom || depth > 12) {
    const it = getItem(tenantId, itemId);
    return it ? it.cost_price : 0;
  }
  let total = 0;
  for (const ln of bom.lines) total += rollupCost(tenantId, ln.item_id, depth + 1) * ln.qty;
  return round(total / (bom.output_qty || 1));
}

/**
 * MF-04: explode one or more planned orders into net material requirements,
 * netting a shared stock pool at every level (multi-level MRP). Manufactured
 * shortfalls become suggested production; purchased shortfalls become suggested POs.
 * orders = [{ bom, qty }]
 */
function runMrp(tenantId, orders) {
  const pool = {}; // remaining available stock per item, shared across the run
  const avail = (id) => {
    if (!(id in pool)) pool[id] = getItem(tenantId, id)?.stock_qty ?? 0;
    return pool[id];
  };
  const purchase = {}, produce = {};

  const resolve = (itemId, need, depth) => {
    if (depth > 12 || need <= 0) return;
    const have = avail(itemId);
    const alloc = Math.min(have, need);
    pool[itemId] = round(have - alloc);
    const net = round(need - alloc);
    const item = getItem(tenantId, itemId);
    const sub = bomForItem(tenantId, itemId);
    const bucket = sub ? produce : purchase;
    const rec = bucket[itemId] || (bucket[itemId] = {
      item_id: itemId, name: item?.name, sku: item?.sku, uom: item?.uom,
      on_hand: item?.stock_qty ?? 0, cost_price: item?.cost_price ?? 0, gross: 0, net: 0,
    });
    rec.gross = round(rec.gross + need);
    rec.net = round(rec.net + net);
    if (sub && net > 0) {
      for (const ln of sub.lines) resolve(ln.item_id, round(ln.qty * net / (sub.output_qty || 1)), depth + 1);
    }
  };

  for (const o of orders) {
    if (!o.bom) continue;
    for (const ln of o.bom.lines) resolve(ln.item_id, round(ln.qty * o.qty / (o.bom.output_qty || 1)), 0);
  }
  return { purchase: Object.values(purchase), produce: Object.values(produce) };
}

function round(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 1000) / 1000; }

module.exports = { getItem, bomForItem, rollupCost, runMrp, round };
