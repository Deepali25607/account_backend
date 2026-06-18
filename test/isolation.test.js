/**
 * Automated tenant-isolation tests — addresses the BRD's top security risk
 * ("Multi-tenant data isolation failure", §13) and §7.1 tenant isolation.
 *
 * Spins up the API on a throwaway database, creates two tenants, and asserts
 * that neither can read or modify the other's data.
 *
 * Run:  npm test          (server is started/stopped automatically)
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 5099;
const BASE = `http://localhost:${PORT}`;
const DB = path.join(__dirname, "iso-test.sqlite");
let server;

const api = async (method, pathname, { token, body } = {}) => {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
};

const register = (company, email) =>
  api("POST", "/api/auth/register", { body: { company, name: "Owner", email, password: "pass1234", tier: "premium" } });

before(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: "test-secret" },
    stdio: "ignore",
  });
  // wait for health
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});

after(() => {
  if (server) server.kill();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch { /* locked */ }
});

test("a tenant cannot read or modify another tenant's data", async () => {
  const a = (await register("Alpha Co", "alpha@test.com")).data.token;
  const b = (await register("Bravo Co", "bravo@test.com")).data.token;
  assert.ok(a && b, "both tenants registered");

  // each creates an item
  const itemA = (await api("POST", "/api/items", { token: a, body: { sku: "A-1", name: "Alpha Widget", material_type: "trading", stock_qty: 10 } })).data;
  const itemB = (await api("POST", "/api/items", { token: b, body: { sku: "B-1", name: "Bravo Widget", material_type: "trading", stock_qty: 10 } })).data;

  // 1. listing is scoped — A sees only its own item
  const listA = (await api("GET", "/api/items", { token: a })).data;
  assert.equal(listA.length, 1, "A sees exactly one item");
  assert.equal(listA[0].id, itemA.id);
  assert.ok(!listA.some((i) => i.id === itemB.id), "A does not see B's item");

  // 2. A cannot edit B's item (scoped lookup → 404)
  const editAttempt = await api("PUT", `/api/items/${itemB.id}`, { token: a, body: { name: "hacked" } });
  assert.equal(editAttempt.status, 404, "A editing B's item is 404");

  // 3. A cannot adjust B's stock
  const adjustAttempt = await api("POST", `/api/items/${itemB.id}/adjust`, { token: a, body: { qty_delta: -5, reason: "x" } });
  assert.equal(adjustAttempt.status, 404, "A adjusting B's stock is 404");
  const itemBafter = (await api("GET", "/api/items", { token: b })).data[0];
  assert.equal(itemBafter.stock_qty, 10, "B's stock is untouched");

  // 4. transactions are scoped — A cannot read B's purchase
  const vendorB = (await api("POST", "/api/vendors", { token: b, body: { name: "B Vendor" } })).data;
  const purchaseB = (await api("POST", "/api/purchases", { token: b, body: { vendor_id: vendorB.id, lines: [{ item_id: itemB.id, qty: 1, unit_price: 5 }] } })).data;
  const readAttempt = await api("GET", `/api/purchases/${purchaseB.id}`, { token: a });
  assert.equal(readAttempt.status, 404, "A reading B's purchase is 404");

  // 5. team lists are scoped — A sees only its own owner
  const teamA = (await api("GET", "/api/users", { token: a })).data;
  assert.equal(teamA.users.length, 1, "A sees only its own user");
  assert.equal(teamA.users[0].email, "alpha@test.com");

  // 6. no token → rejected
  const noAuth = await api("GET", "/api/items", {});
  assert.equal(noAuth.status, 401, "missing token is 401");
});
