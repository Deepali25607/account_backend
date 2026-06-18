/**
 * Populate the seeded demo tenant with a full, realistic scenario so every
 * screen has data to show: multi-month purchases & sales, payments, extra
 * users, a BOM and a partially-completed production order.
 *
 * Run:  npm run demo        (resets DB, seeds, then populates + verifies)
 * Idempotent: skips if demo transactions already exist.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const PORT = 5000;
const BASE = `http://localhost:${PORT}`;

const api = async (method, p, token, body) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  if (res.status >= 400) throw new Error(`${method} ${p} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
};

const dateMonthsAgo = (m, day = 15) => {
  const d = new Date(); d.setMonth(d.getMonth() - m); d.setDate(day);
  return d.toISOString().slice(0, 10);
};

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

async function run() {
  const { token } = await api("POST", "/api/auth/login", null, { email: "owner@demo.com", password: "demo1234" });

  const existing = await api("GET", "/api/sales", token);
  if (existing.length) { console.log("Demo transactions already present — skipping populate."); return; }

  const items = await api("GET", "/api/items", token);
  const byd = (sku) => items.find((i) => i.sku === sku);
  const vendors = await api("GET", "/api/vendors", token);
  const customers = await api("GET", "/api/customers", token);

  // ── multi-month purchases (stock in) ──
  for (let m = 5; m >= 0; m--) {
    await api("POST", "/api/purchases", token, {
      vendor_id: vendors[m % vendors.length].id, doc_date: dateMonthsAgo(m, 3), paid: 0,
      lines: [
        { item_id: byd("SKU-1001").id, qty: 200, unit_price: 2.4, tax_rate: 18 },
        { item_id: byd("SKU-1002").id, qty: 200, unit_price: 1.1, tax_rate: 18 },
        { item_id: byd("SKU-1004").id, qty: 100, unit_price: 44, tax_rate: 12 },
      ],
    });
  }

  // ── multi-month sales (drives the dashboard trend). Older invoices are paid
  //    in full via the payments API; the most recent month is left outstanding. ──
  for (let m = 5; m >= 0; m--) {
    const sale = await api("POST", "/api/sales", token, {
      customer_id: customers[m % customers.length].id, doc_date: dateMonthsAgo(m, 20), received: 0,
      lines: [
        { item_id: byd("SKU-1003").id, qty: 3 + m, unit_price: 2800, tax_rate: 18 },
        { item_id: byd("SKU-1004").id, qty: 20, unit_price: 90, tax_rate: 12 },
      ],
    });
    if (m > 0) // pay older invoices fully (allocation caps at the invoice balance)
      await api("POST", "/api/accounting/payments", token, {
        kind: "receipt", party_id: customers[m % customers.length].id, account: "bank",
        amount: sale.grand_total, pay_date: dateMonthsAgo(m, 25),
      });
  }

  // ── a partial receipt on the latest invoice + a vendor payment (AC-06) ──
  await api("POST", "/api/accounting/payments", token, { kind: "receipt", party_id: customers[0].id, account: "bank", amount: 5000 });
  await api("POST", "/api/accounting/payments", token, { kind: "payment", party_id: vendors[0].id, account: "bank", amount: 3000 });

  // ── extra users (UM) ──
  for (const u of [
    { name: "Anita Accountant", email: "anita@demo.com", password: "anita1234", role: "accountant" },
    { name: "Sam Sales", email: "sam@demo.com", password: "sam12345", role: "sales" },
  ]) { try { await api("POST", "/api/users", token, u); } catch {} }

  // ── manufacturing: BOM + partially-completed production order ──
  const bom = await api("POST", "/api/manufacturing/boms", token, {
    item_id: byd("SKU-1003").id, name: "Office Chair build", output_qty: 1, std_cost: 1700,
    lines: [{ item_id: byd("SKU-1001").id, qty: 4 }, { item_id: byd("SKU-1002").id, qty: 4 }],
  });
  const po = await api("POST", "/api/manufacturing/production-orders", token, { bom_id: bom.id, qty: 50, planned_date: dateMonthsAgo(0, 25) });
  await api("POST", `/api/manufacturing/production-orders/${po.id}/complete`, token, { qty: 20 }); // partial

  // ── multi-location (IN-06): a second warehouse + a transfer ──
  const main = (await api("GET", "/api/locations", token)).find((l) => l.is_default);
  const east = await api("POST", "/api/locations", token, { name: "East Depot" });
  await api("POST", "/api/locations/transfer", token, { item_id: byd("SKU-1004").id, from_location_id: main.id, to_location_id: east.id, qty: 150 });

  // ── verification summary ──
  const dash = await api("GET", "/api/reports/dashboard", token);
  const tb = await api("GET", "/api/accounting/trial-balance", token);
  const pnl = await api("GET", "/api/accounting/pnl", token);
  const bs = await api("GET", "/api/accounting/balance-sheet", token);
  const out = await api("GET", "/api/reports/outstanding", token);

  console.log("\n──────── Demo data created. Verification ────────");
  console.log(`Sales (30d): ₹${dash.sales30}   Purchases (30d): ₹${dash.purch30}`);
  console.log(`Stock value: ₹${dash.stockValue}   Low-stock items: ${dash.lowStock}`);
  console.log(`Sales-trend months on dashboard: ${dash.trend.length}`);
  console.log(`Trial balance: Dr ₹${tb.totals.debit} = Cr ₹${tb.totals.credit}  → balanced: ${tb.balanced}`);
  console.log(`P&L net profit: ₹${pnl.netProfit}`);
  console.log(`Balance sheet: assets ₹${bs.totalAssets} = liab ₹${bs.totalLiabilities} + equity ₹${bs.totalEquity}  → balanced: ${bs.balanced}`);
  console.log(`Outstanding receivables: ${out.receivables.length}, payables: ${out.payables.length}`);
  const loc = await api("GET", "/api/locations/stock", token);
  const bulb = loc.items.find((i) => i.sku === "SKU-1004");
  console.log(`Warehouses: ${loc.locations.length} → LED Bulb split ${bulb.byLocation.map((b) => b.location + ":" + b.qty).join("  ")}`);
  console.log("Login: owner@demo.com / demo1234 (Premium — all modules)\n");
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT) }, stdio: "ignore",
  });
  try {
    await waitHealth();
    await run();
  } catch (e) {
    console.error("Demo data failed:", e.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
})();
