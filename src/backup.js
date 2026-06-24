const db = require("./db");

/**
 * Full company (tenant) backup & restore.
 *
 * Export gathers every tenant-scoped business table into a single JSON document.
 * Import REPLACES the current tenant's data with the backup's contents. Because
 * row ids are global AUTOINCREMENT keys shared across tenants, a safe restore
 * cannot preserve ids — it re-inserts each row with a fresh id and rewrites all
 * foreign keys through an old→new id map, table by table, in dependency order.
 *
 * Out of scope by design: users/auth, audit log, and all platform-global tables
 * (pricing, plan requests, coupons). Subscription/platform fields on the tenant
 * row (tier, active, is_platform) are never overwritten by a restore.
 */

// Tenant identity/profile fields a restore may overwrite (never tier/active/platform).
const PROFILE_COLS = ["name", "base_currency", "gstin", "pan", "phone", "email", "website", "address", "city", "state", "pincode", "logo"];

// How each backed-up table is scoped to a tenant (used for both export and the
// wipe step of import). Line tables have no tenant_id, so they scope via parent.
const SCOPE = {
  accounts: "tenant_id = ?",
  items: "tenant_id = ?",
  vendors: "tenant_id = ?",
  customers: "tenant_id = ?",
  locations: "tenant_id = ?",
  role_permissions: "tenant_id = ?",
  item_location_stock: "tenant_id = ?",
  boms: "tenant_id = ?",
  bom_lines: "bom_id IN (SELECT id FROM boms WHERE tenant_id = ?)",
  purchases: "tenant_id = ?",
  purchase_lines: "purchase_id IN (SELECT id FROM purchases WHERE tenant_id = ?)",
  sales: "tenant_id = ?",
  sale_lines: "sale_id IN (SELECT id FROM sales WHERE tenant_id = ?)",
  production_orders: "tenant_id = ?",
  stock_movements: "tenant_id = ?",
  journal_entries: "tenant_id = ?",
  journal_lines: "entry_id IN (SELECT id FROM journal_entries WHERE tenant_id = ?)",
  payments: "tenant_id = ?",
};

// Polymorphic reference resolvers. stock_movements/journal_entries point at a row
// in a table named by ref_type; payments.party_id is a vendor or a customer by kind.
const MOVE_REF = { item: "items", purchase: "purchases", sale: "sales", production_order: "production_orders", location: "locations" };
const JOURNAL_REF = { sale: "sales", sale_cogs: "sales", purchase: "purchases" };
const movementRef = (row, maps) => {
  const t = MOVE_REF[row.ref_type];
  return { ref_id: t && row.ref_id != null ? (maps[t]?.[row.ref_id] ?? null) : (t ? null : row.ref_id ?? null) };
};
const journalRef = (row, maps) => {
  const t = JOURNAL_REF[row.ref_type];
  return { ref_id: t && row.ref_id != null ? (maps[t]?.[row.ref_id] ?? null) : null };
};
const paymentParty = (row, maps) => {
  const t = row.kind === "payment" ? "vendors" : "customers";
  return { party_id: maps[t]?.[row.party_id] ?? row.party_id };
};

// Insertion order (parents before children). `map` names the id-map this table
// fills for later FK remaps; `fks` maps a column to the map it resolves through;
// `poly` is a custom resolver for polymorphic columns.
const ORDER = [
  { t: "accounts", map: "accounts" },
  { t: "items", map: "items" },
  { t: "vendors", map: "vendors" },
  { t: "customers", map: "customers" },
  { t: "locations", map: "locations" },
  { t: "role_permissions" },
  { t: "item_location_stock", fks: { item_id: "items", location_id: "locations" } },
  { t: "boms", map: "boms", fks: { item_id: "items" } },
  { t: "bom_lines", fks: { bom_id: "boms", item_id: "items" } },
  { t: "purchases", map: "purchases", fks: { vendor_id: "vendors", location_id: "locations" } },
  { t: "purchase_lines", fks: { purchase_id: "purchases", item_id: "items" } },
  { t: "sales", map: "sales", fks: { customer_id: "customers", location_id: "locations" } },
  { t: "sale_lines", fks: { sale_id: "sales", item_id: "items" } },
  { t: "production_orders", map: "production_orders", fks: { bom_id: "boms" } },
  { t: "stock_movements", fks: { item_id: "items" }, poly: movementRef },
  { t: "journal_entries", map: "journal_entries", poly: journalRef },
  { t: "journal_lines", fks: { entry_id: "journal_entries", account_id: "accounts" } },
  { t: "payments", poly: paymentParty },
];

const colsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function httpError(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

/** Build a self-contained JSON backup of one tenant's company data. */
function exportCompany(tenantId) {
  const tenant = db.prepare("SELECT * FROM tenants WHERE id=?").get(tenantId);
  const profile = {};
  for (const c of PROFILE_COLS) profile[c] = tenant?.[c] ?? null;
  const data = {};
  for (const { t } of ORDER) data[t] = db.prepare(`SELECT * FROM ${t} WHERE ${SCOPE[t]}`).all(tenantId);
  const records = Object.values(data).reduce((n, rows) => n + rows.length, 0);
  return { format: "ledgerflow-company-backup", version: 1, exportedAt: new Date().toISOString(), records, tenant: profile, data };
}

/** Insert backup rows for one table, remapping ids/FKs and recording new ids. */
function insertTable(spec, rows, tenantId, maps) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const schemaCols = colsOf(spec.t).filter((c) => c !== "id");
  const hasTenant = schemaCols.includes("tenant_id");
  const idMap = spec.map ? (maps[spec.map] = maps[spec.map] || {}) : null;
  const stmtCache = new Map(); // column-signature → prepared INSERT (rows usually share columns)

  for (const row of rows) {
    const out = { ...row };
    delete out.id;
    if (hasTenant) out.tenant_id = tenantId;
    if (spec.fks) for (const [col, mapName] of Object.entries(spec.fks)) {
      if (out[col] != null) out[col] = maps[mapName]?.[out[col]] ?? null;
    }
    if (spec.poly) Object.assign(out, spec.poly(row, maps));

    // Only emit columns the current schema knows AND the row provides, so a backup
    // taken before a column existed falls back to that column's default.
    const useCols = schemaCols.filter((c) => out[c] !== undefined);
    const key = useCols.join(",");
    let stmt = stmtCache.get(key);
    if (!stmt) {
      stmt = db.prepare(`INSERT INTO ${spec.t} (${useCols.join(",")}) VALUES (${useCols.map(() => "?").join(",")})`);
      stmtCache.set(key, stmt);
    }
    const res = stmt.run(useCols.map((c) => out[c]));
    if (idMap) idMap[row.id] = res.lastInsertRowid;
  }
  return rows.length;
}

/** Restore a backup into `tenantId`, replacing its current company data. Atomic. */
function importCompany(tenantId, payload) {
  if (!payload || payload.format !== "ledgerflow-company-backup")
    throw httpError(400, "This file is not a valid company backup.");
  if (!payload.data || typeof payload.data !== "object")
    throw httpError(400, "Backup file is missing its data section.");

  const maps = {};
  const restore = db.transaction(() => {
    // 1. Wipe current data — referencing tables first so foreign keys stay valid.
    for (const { t } of [...ORDER].reverse()) db.prepare(`DELETE FROM ${t} WHERE ${SCOPE[t]}`).run(tenantId);

    // 2. Restore company identity/profile (never tier/active/platform flags).
    if (payload.tenant && typeof payload.tenant === "object") {
      const cols = PROFILE_COLS.filter((c) => c in payload.tenant);
      if (cols.length) {
        db.prepare(`UPDATE tenants SET ${cols.map((c) => `${c}=@${c}`).join(", ")} WHERE id=@id`)
          .run({ ...Object.fromEntries(cols.map((c) => [c, payload.tenant[c] ?? null])), id: tenantId });
      }
    }

    // 3. Re-insert every table in dependency order, remapping ids as we go.
    const counts = {};
    for (const spec of ORDER) counts[spec.t] = insertTable(spec, payload.data[spec.t], tenantId, maps);
    return counts;
  });

  return restore();
}

module.exports = { exportCompany, importCompany };
