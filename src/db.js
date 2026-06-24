const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Schema covers the full BRD data model. Basic-tier tables are used by the
 * working APIs; Standard/Premium tables (ledger, BOM, production) are created
 * up front so the higher tiers extend without a migration -- per BRD §5.3
 * principle 2 ("no data migration on upgrade").
 */
function init() {
  db.exec(`
    -- ── Tenancy & users ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tenants (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      tier         TEXT    NOT NULL DEFAULT 'basic'
                   CHECK (tier IN ('basic','standard','premium')),
      base_currency TEXT   NOT NULL DEFAULT 'INR',
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
      name          TEXT    NOT NULL,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'owner'
                    CHECK (role IN ('owner','accountant','sales','purchase','production')),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- role → module permission matrix (UM-03)
    CREATE TABLE IF NOT EXISTS role_permissions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
      role       TEXT    NOT NULL,
      module     TEXT    NOT NULL,
      can_view   INTEGER NOT NULL DEFAULT 0,
      can_create INTEGER NOT NULL DEFAULT 0,
      can_edit   INTEGER NOT NULL DEFAULT 0,
      can_approve INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0,
      UNIQUE (tenant_id, role, module)
    );

    -- audit trail (UM-04)
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL,
      user_id    INTEGER,
      action     TEXT    NOT NULL,
      entity     TEXT,
      entity_id  INTEGER,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Masters ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      sku         TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      category    TEXT,
      material_type TEXT  NOT NULL DEFAULT 'trading',  -- user-defined classification (not auto-derived)
      uom         TEXT    NOT NULL DEFAULT 'unit',
      cost_price  REAL    NOT NULL DEFAULT 0,   -- weighted-avg cost (IN-05)
      sale_price  REAL    NOT NULL DEFAULT 0,
      tax_rate    REAL    NOT NULL DEFAULT 0,   -- GST % (Standard+)
      stock_qty   REAL    NOT NULL DEFAULT 0,   -- real-time on-hand (IN-02)
      reorder_lvl REAL    NOT NULL DEFAULT 0,   -- low-stock alert (IN-03)
      is_manufactured INTEGER NOT NULL DEFAULT 0, -- has a BOM (Premium)
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tenant_id, sku)
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      name        TEXT    NOT NULL,
      email       TEXT,
      phone       TEXT,
      tax_no      TEXT,                          -- GSTIN (PU-02)
      payment_terms TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      name        TEXT    NOT NULL,
      email       TEXT,
      phone       TEXT,
      tax_no      TEXT,
      payment_terms TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Transactions: purchases & sales ─────────────────────────────
    -- doc_type distinguishes orders/invoices/returns within one table
    CREATE TABLE IF NOT EXISTS purchases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      vendor_id   INTEGER NOT NULL REFERENCES vendors(id),
      doc_no      TEXT    NOT NULL,
      doc_type    TEXT    NOT NULL DEFAULT 'purchase'
                  CHECK (doc_type IN ('purchase','return')),
      doc_date    TEXT    NOT NULL DEFAULT (date('now')),
      status      TEXT    NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('draft','confirmed','cancelled')),
      subtotal    REAL    NOT NULL DEFAULT 0,
      tax_total   REAL    NOT NULL DEFAULT 0,
      grand_total REAL    NOT NULL DEFAULT 0,
      paid        REAL    NOT NULL DEFAULT 0,    -- for payables (PU-06)
      notes       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS purchase_lines (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      item_id     INTEGER NOT NULL REFERENCES items(id),
      qty         REAL    NOT NULL,
      unit_price  REAL    NOT NULL,
      tax_rate    REAL    NOT NULL DEFAULT 0,
      line_total  REAL    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      doc_no      TEXT    NOT NULL,
      doc_type    TEXT    NOT NULL DEFAULT 'sale'
                  CHECK (doc_type IN ('sale','return')),
      doc_date    TEXT    NOT NULL DEFAULT (date('now')),
      status      TEXT    NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('draft','confirmed','cancelled')),
      subtotal    REAL    NOT NULL DEFAULT 0,
      tax_total   REAL    NOT NULL DEFAULT 0,
      grand_total REAL    NOT NULL DEFAULT 0,
      received    REAL    NOT NULL DEFAULT 0,    -- for receivables (SA-06)
      cogs        REAL    NOT NULL DEFAULT 0,    -- cost of goods sold (profit report)
      notes       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sale_lines (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id     INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      item_id     INTEGER NOT NULL REFERENCES items(id),
      qty         REAL    NOT NULL,
      unit_price  REAL    NOT NULL,
      tax_rate    REAL    NOT NULL DEFAULT 0,
      line_total  REAL    NOT NULL
    );

    -- every stock change, append-only (IN-02, RP-04)
    CREATE TABLE IF NOT EXISTS stock_movements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      item_id     INTEGER NOT NULL REFERENCES items(id),
      qty_delta   REAL    NOT NULL,              -- +in / -out
      reason      TEXT    NOT NULL,              -- purchase|sale|return|adjustment|production
      ref_type    TEXT,
      ref_id      INTEGER,
      note        TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- IN-06: warehouses / locations (Premium). "Main Store" (is_default) holds the
    -- implicit balance = items.stock_qty − Σ(named-location qty); only NAMED
    -- locations store rows in item_location_stock, so the aggregate stays authoritative.
    CREATE TABLE IF NOT EXISTS locations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
      name       TEXT    NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS item_location_stock (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      item_id     INTEGER NOT NULL REFERENCES items(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      qty         REAL    NOT NULL DEFAULT 0,
      UNIQUE (item_id, location_id)
    );

    -- ── Standard tier: accounting (scaffolded) ──────────────────────
    CREATE TABLE IF NOT EXISTS accounts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
      code       TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      type       TEXT    NOT NULL CHECK (type IN ('asset','liability','equity','income','expense'))
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
      entry_date TEXT    NOT NULL DEFAULT (date('now')),
      memo       TEXT,
      ref_type   TEXT,
      ref_id     INTEGER
    );

    CREATE TABLE IF NOT EXISTS journal_lines (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id    INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id  INTEGER NOT NULL REFERENCES accounts(id),
      debit       REAL    NOT NULL DEFAULT 0,
      credit      REAL    NOT NULL DEFAULT 0
    );

    -- ── Premium tier: manufacturing (scaffolded) ────────────────────
    CREATE TABLE IF NOT EXISTS boms (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      item_id     INTEGER NOT NULL REFERENCES items(id), -- output item
      name        TEXT    NOT NULL,
      output_qty  REAL    NOT NULL DEFAULT 1,
      std_cost    REAL    NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bom_lines (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_id      INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
      item_id     INTEGER NOT NULL REFERENCES items(id), -- component
      qty         REAL    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS production_orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      bom_id      INTEGER NOT NULL REFERENCES boms(id),
      qty         REAL    NOT NULL,
      completed_qty REAL  NOT NULL DEFAULT 0,   -- WIP partial completion (MF-06)
      planned_date TEXT,
      status      TEXT    NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','in_progress','completed','closed')),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- AC-06: bank & cash receipts/payments against party balances
    CREATE TABLE IF NOT EXISTS payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      kind        TEXT    NOT NULL CHECK (kind IN ('receipt','payment')),
      party_id    INTEGER NOT NULL,
      account     TEXT    NOT NULL CHECK (account IN ('cash','bank')),
      amount      REAL    NOT NULL,
      pay_date    TEXT    NOT NULL DEFAULT (date('now')),
      note        TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_items_tenant   ON items(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_purch_tenant   ON purchases(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sales_tenant   ON sales(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_moves_item     ON stock_movements(item_id);
  `);
}

init();

// Lightweight migration for DBs created before a column existed.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn("production_orders", "completed_qty", "completed_qty REAL NOT NULL DEFAULT 0");
ensureColumn("purchases", "location_id", "location_id INTEGER");
ensureColumn("sales", "location_id", "location_id INTEGER");
ensureColumn("items", "material_type", "material_type TEXT NOT NULL DEFAULT 'trading'");
ensureColumn("items", "barcode", "barcode TEXT");   // IN-01: scannable barcode / EAN
ensureColumn("items", "hsn", "hsn TEXT");           // GST HSN/SAC code (master-defined)
// Unique per tenant, but only when a barcode is set (multiple NULLs allowed).
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_items_barcode ON items(tenant_id, barcode) WHERE barcode IS NOT NULL");
// Platform-wide subscription pricing, managed by the super admin.
db.exec(`CREATE TABLE IF NOT EXISTS plan_pricing (
  tier          TEXT PRIMARY KEY CHECK (tier IN ('basic','standard','premium')),
  price_monthly REAL NOT NULL DEFAULT 0,
  price_yearly  REAL NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'INR',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Plan upgrade/downgrade requests — manual approval + payment-verification workflow.
db.exec(`CREATE TABLE IF NOT EXISTS plan_requests (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id            INTEGER NOT NULL REFERENCES tenants(id),
  requested_tier       TEXT NOT NULL CHECK (requested_tier IN ('basic','standard','premium')),
  current_tier         TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','awaiting_payment','payment_reported','activated','rejected','cancelled')),
  note                 TEXT,    -- org's note on the request
  review_note          TEXT,    -- super admin's note / rejection reason
  payment_instructions TEXT,    -- shared on approval
  payment_qr           TEXT,    -- QR image data-URL shared on approval
  amount               REAL,
  currency             TEXT,
  payment_reference    TEXT,    -- org's payment ref (UTR/UPI txn id)
  requested_by         INTEGER,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Platform manual-payment settings (single row): UPI id, payee, QR, instructions.
db.exec(`CREATE TABLE IF NOT EXISTS platform_payment (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  upi_id       TEXT,
  payee_name   TEXT,
  qr_image     TEXT,
  instructions TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Platform-wide discount coupons, managed by the super admin.
db.exec(`CREATE TABLE IF NOT EXISTS coupons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  description     TEXT,
  discount_type   TEXT NOT NULL CHECK (discount_type IN ('percent','amount')),
  discount_value  REAL NOT NULL,
  applies_to      TEXT NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all','basic','standard','premium')),
  max_redemptions INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
  times_redeemed  INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,                          -- YYYY-MM-DD, NULL = no expiry
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Payment received/paid at invoice time → which money account it hit (cash|bank)
ensureColumn("sales", "payment_account", "payment_account TEXT NOT NULL DEFAULT 'cash'");
ensureColumn("purchases", "payment_account", "payment_account TEXT NOT NULL DEFAULT 'cash'");
// Document-level additional charges (e.g. freight/packing) & additional discount.
// grand_total = subtotal + tax_total − discount + extra_charges.
// `discount` is the resolved currency amount used in totals/accounting; the
// discount can be entered as a flat amount or a % of subtotal, so we also keep
// `discount_type` ('amount'|'percent') and the raw `discount_value` entered.
ensureColumn("sales", "discount", "discount REAL NOT NULL DEFAULT 0");
ensureColumn("sales", "discount_type", "discount_type TEXT NOT NULL DEFAULT 'amount'");
ensureColumn("sales", "discount_value", "discount_value REAL NOT NULL DEFAULT 0");
ensureColumn("sales", "extra_charges", "extra_charges REAL NOT NULL DEFAULT 0");
ensureColumn("sales", "extra_charges_note", "extra_charges_note TEXT");
ensureColumn("purchases", "discount", "discount REAL NOT NULL DEFAULT 0");
ensureColumn("purchases", "discount_type", "discount_type TEXT NOT NULL DEFAULT 'amount'");
ensureColumn("purchases", "discount_value", "discount_value REAL NOT NULL DEFAULT 0");
ensureColumn("purchases", "extra_charges", "extra_charges REAL NOT NULL DEFAULT 0");
ensureColumn("purchases", "extra_charges_note", "extra_charges_note TEXT");
// Item-wise (line-level) discount, applied to a line's base before tax. `discount`
// is the resolved currency amount used in totals; `discount_type`/`discount_value`
// keep what was entered (flat amount or % of the line) so edits round-trip.
ensureColumn("purchase_lines", "discount", "discount REAL NOT NULL DEFAULT 0");
ensureColumn("purchase_lines", "discount_type", "discount_type TEXT NOT NULL DEFAULT 'amount'");
ensureColumn("purchase_lines", "discount_value", "discount_value REAL NOT NULL DEFAULT 0");
ensureColumn("sale_lines", "discount", "discount REAL NOT NULL DEFAULT 0");
ensureColumn("sale_lines", "discount_type", "discount_type TEXT NOT NULL DEFAULT 'amount'");
ensureColumn("sale_lines", "discount_value", "discount_value REAL NOT NULL DEFAULT 0");
// Platform-operator (super-admin) support
ensureColumn("users", "is_platform_admin", "is_platform_admin INTEGER NOT NULL DEFAULT 0");
ensureColumn("tenants", "active", "active INTEGER NOT NULL DEFAULT 1");   // org suspend/restore
ensureColumn("tenants", "is_platform", "is_platform INTEGER NOT NULL DEFAULT 0"); // hidden platform tenant
// Company profile (owner-editable) — appears on invoices/receipts & GST documents.
ensureColumn("tenants", "gstin", "gstin TEXT");          // GST identification number
ensureColumn("tenants", "pan", "pan TEXT");              // PAN
ensureColumn("tenants", "phone", "phone TEXT");
ensureColumn("tenants", "email", "email TEXT");
ensureColumn("tenants", "website", "website TEXT");
ensureColumn("tenants", "address", "address TEXT");      // street / building (multi-line)
ensureColumn("tenants", "city", "city TEXT");
ensureColumn("tenants", "state", "state TEXT");
ensureColumn("tenants", "pincode", "pincode TEXT");
ensureColumn("tenants", "logo", "logo TEXT");           // company logo as a data-URL (shown on invoices)

module.exports = db;
