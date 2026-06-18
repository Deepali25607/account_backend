/**
 * Seed a demo tenant so the app is usable immediately.
 * Run with: npm run seed   (idempotent — skips if the demo user exists)
 *
 * Demo login →  owner@demo.com / demo1234   (Premium tier, so every module shows)
 */
const bcrypt = require("bcryptjs");
const db = require("./db");

const EMAIL = "owner@demo.com";

// ── Platform super-admin (cross-tenant operator) ────────────────────────────
// Idempotent and independent of the demo tenant so it is always present.
// Override via env: PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD.
const PA_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || "admin@ledgerflow.com";
const PA_PASS = process.env.PLATFORM_ADMIN_PASSWORD || "admin1234";
if (!db.prepare("SELECT id FROM users WHERE is_platform_admin = 1").get()) {
  db.transaction(() => {
    // A hidden tenant satisfies the FK without ever appearing in the org list.
    let pt = db.prepare("SELECT id FROM tenants WHERE is_platform = 1").get();
    if (!pt) {
      const r = db.prepare("INSERT INTO tenants (name, tier, is_platform) VALUES (?, 'premium', 1)").run("LedgerFlow Platform");
      pt = { id: r.lastInsertRowid };
    }
    db.prepare("INSERT INTO users (tenant_id, name, email, password_hash, role, is_platform_admin) VALUES (?,?,?,?,'owner',1)")
      .run(pt.id, "Platform Admin", PA_EMAIL, bcrypt.hashSync(PA_PASS, 10));
  })();
  console.log(`Created platform super-admin:  ${PA_EMAIL}  /  ${PA_PASS}`);
}

if (db.prepare("SELECT id FROM users WHERE email=?").get(EMAIL)) {
  console.log("Demo data already present — nothing to do.");
  console.log(`\n  Tenant owner:    owner@demo.com  /  demo1234`);
  console.log(`  Platform admin:  ${PA_EMAIL}  /  ${PA_PASS}\n`);
  process.exit(0);
}

const tx = db.transaction(() => {
  const tenant = db.prepare("INSERT INTO tenants (name, tier) VALUES (?, 'premium')").run("Demo Traders Pvt Ltd");
  const tid = tenant.lastInsertRowid;
  db.prepare("INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,'owner')")
    .run(tid, "Demo Owner", EMAIL, bcrypt.hashSync("demo1234", 10));

  const items = [
    // sku, name, category, material_type, uom, cost, sale, tax, stock, reorder, barcode, hsn
    ["SKU-1001", "Steel Bolt M6", "Hardware", "raw", "pcs", 2.5, 5, 18, 800, 200, "8901000000011", "7318"],
    ["SKU-1002", "Steel Nut M6", "Hardware", "raw", "pcs", 1.2, 3, 18, 950, 200, "8901000000028", "7318"],
    ["SKU-1003", "Office Chair", "Furniture", "finished", "unit", 1800, 2800, 18, 40, 10, "8901000000035", "9401"],
    ["SKU-1004", "LED Bulb 9W", "Electrical", "trading", "pcs", 45, 90, 12, 300, 100, "8901000000042", "8539"],
    ["SKU-1005", "A4 Paper Ream", "Stationery", "trading", "ream", 220, 320, 12, 25, 30, "8901000000059", "4802"],
  ];
  const insItem = db.prepare(
    `INSERT INTO items (tenant_id, sku, name, category, material_type, uom, cost_price, sale_price, tax_rate, stock_qty, reorder_lvl, barcode, hsn)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const it of items) insItem.run(tid, ...it);

  const insV = db.prepare("INSERT INTO vendors (tenant_id, name, email, tax_no) VALUES (?,?,?,?)");
  insV.run(tid, "Acme Supplies", "sales@acme.test", "29ABCDE1234F1Z5");
  insV.run(tid, "Bharat Hardware", "info@bharat.test", "27PQRSX5678G2Z1");

  const insC = db.prepare("INSERT INTO customers (tenant_id, name, email, tax_no) VALUES (?,?,?,?)");
  insC.run(tid, "Retail World", "buy@retailworld.test", "29ZZTOP9999Q1Z2");
  insC.run(tid, "City Mart", "orders@citymart.test", null);

  console.log("Seeded demo tenant (Premium).");
});
tx();

console.log("\n  Login:  owner@demo.com  /  demo1234\n");
process.exit(0);
