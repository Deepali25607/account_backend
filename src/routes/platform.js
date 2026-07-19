/**
 * Platform-operator (super-admin) API — cross-tenant administration.
 * Every route requires a platform-admin token (requirePlatformAdmin).
 * This is the ONLY place the tenant-isolation boundary is intentionally
 * crossed; normal tenant routes can never reach another org's data.
 */
const express = require("express");
const db = require("../db");
const { auth, requirePlatformAdmin } = require("../middleware");
const { featuresForTier, USER_LIMITS } = require("../entitlements");
const { ensureChart } = require("../accounting");
const { ensureRolePermissions } = require("../permissions");
const { ensureDefaultLocation } = require("../locations");
const { tierHasFeature } = require("../entitlements");
const { getPricing, setPricing } = require("../pricing");

const router = express.Router();
router.use(auth, requirePlatformAdmin);

const TIERS = ["basic", "standard", "premium"];

/** GET /platform/pricing — the platform price list. */
router.get("/pricing", (req, res) => res.json(getPricing()));

/** PUT /platform/pricing/:tier — set a plan's monthly/yearly price. */
router.put("/pricing/:tier", (req, res) => {
  if (!TIERS.includes(req.params.tier)) return res.status(400).json({ error: "Invalid tier" });
  res.json(setPricing(req.params.tier, req.body || {}));
});

/* ── Discount coupons ── */
const APPLIES = ["all", "basic", "standard", "premium"];

router.get("/coupons", (req, res) => {
  res.json(db.prepare("SELECT * FROM coupons ORDER BY active DESC, id DESC").all());
});

router.post("/coupons", (req, res) => {
  let { code, description, discount_type, discount_value, applies_to, max_redemptions, expires_at } = req.body || {};
  code = (code || "").toString().trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Coupon code is required" });
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) return res.status(400).json({ error: "Code must be 3–24 letters/digits (A–Z, 0–9, -, _)" });
  if (!["percent", "amount"].includes(discount_type)) return res.status(400).json({ error: "discount_type must be 'percent' or 'amount'" });
  const val = Number(discount_value);
  if (!(val > 0)) return res.status(400).json({ error: "discount_value must be greater than 0" });
  if (discount_type === "percent" && val > 100) return res.status(400).json({ error: "A percentage discount can't exceed 100" });
  applies_to = APPLIES.includes(applies_to) ? applies_to : "all";
  try {
    const r = db.prepare(
      "INSERT INTO coupons (code, description, discount_type, discount_value, applies_to, max_redemptions, expires_at) VALUES (?,?,?,?,?,?,?)"
    ).run(code, (description || "").toString().trim() || null, discount_type, val, applies_to,
          Math.max(0, parseInt(max_redemptions, 10) || 0), (expires_at || "").toString().trim() || null);
    res.status(201).json(db.prepare("SELECT * FROM coupons WHERE id=?").get(r.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "That coupon code already exists" });
    throw e;
  }
});

router.patch("/coupons/:id", (req, res) => {
  const c = db.prepare("SELECT * FROM coupons WHERE id=?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Coupon not found" });
  const active = typeof req.body?.active === "boolean" ? (req.body.active ? 1 : 0) : c.active;
  db.prepare("UPDATE coupons SET active=? WHERE id=?").run(active, c.id);
  res.json(db.prepare("SELECT * FROM coupons WHERE id=?").get(c.id));
});

router.delete("/coupons/:id", (req, res) => {
  const c = db.prepare("SELECT * FROM coupons WHERE id=?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Coupon not found" });
  db.prepare("DELETE FROM coupons WHERE id=?").run(c.id);
  res.json({ ok: true, id: c.id });
});

/* ── Manual-payment settings (UPI / QR / instructions) ── */
const paymentSettings = () => db.prepare("SELECT upi_id, payee_name, qr_image, instructions, updated_at FROM platform_payment WHERE id=1").get() || {};

router.get("/payment-settings", (req, res) => res.json(paymentSettings()));

router.put("/payment-settings", (req, res) => {
  const { upi_id, payee_name, qr_image, instructions } = req.body || {};
  const exists = db.prepare("SELECT id FROM platform_payment WHERE id=1").get();
  if (exists) {
    db.prepare("UPDATE platform_payment SET upi_id=?, payee_name=?, qr_image=?, instructions=?, updated_at=datetime('now') WHERE id=1")
      .run(upi_id || null, payee_name || null, qr_image || null, instructions || null);
  } else {
    db.prepare("INSERT INTO platform_payment (id, upi_id, payee_name, qr_image, instructions) VALUES (1,?,?,?,?)")
      .run(upi_id || null, payee_name || null, qr_image || null, instructions || null);
  }
  res.json(paymentSettings());
});

/* ── Plan upgrade requests (review → approve → verify payment → activate) ── */
const reqWithTenant = (id) =>
  db.prepare("SELECT pr.*, t.name AS tenant_name FROM plan_requests pr JOIN tenants t ON t.id=pr.tenant_id WHERE pr.id=?").get(id);

router.get("/plan-requests", (req, res) => {
  res.json(db.prepare(
    `SELECT pr.*, t.name AS tenant_name FROM plan_requests pr JOIN tenants t ON t.id=pr.tenant_id
     WHERE t.is_platform=0
     ORDER BY CASE pr.status WHEN 'payment_reported' THEN 0 WHEN 'pending' THEN 1 WHEN 'awaiting_payment' THEN 2 ELSE 3 END, pr.id DESC`
  ).all());
});

/** Approve a pending request and share payment instructions (→ awaiting_payment). */
router.post("/plan-requests/:id/approve", (req, res) => {
  const pr = reqWithTenant(req.params.id);
  if (!pr) return res.status(404).json({ error: "Request not found" });
  if (pr.status !== "pending") return res.status(409).json({ error: "Only pending requests can be approved" });
  const { payment_instructions, payment_qr, amount, currency } = req.body || {};
  const price = db.prepare("SELECT price_monthly, currency FROM plan_pricing WHERE tier=?").get(pr.requested_tier) || {};
  const s = paymentSettings();
  const amt = amount !== undefined && amount !== "" ? Number(amount) : (price.price_monthly || 0);
  const cur = currency || price.currency || "INR";
  const instr = (payment_instructions || "").trim() ||
    [s.upi_id ? `UPI ID: ${s.upi_id}` : "", s.payee_name ? `Payee: ${s.payee_name}` : "", s.instructions || ""].filter(Boolean).join("\n") || null;
  const qr = payment_qr || s.qr_image || null;
  db.prepare("UPDATE plan_requests SET status='awaiting_payment', payment_instructions=?, payment_qr=?, amount=?, currency=?, review_note=?, updated_at=datetime('now') WHERE id=?")
    .run(instr, qr, amt, cur, (req.body?.review_note || "").trim() || null, pr.id);
  res.json(reqWithTenant(pr.id));
});

/** Reject a request at any open stage. */
router.post("/plan-requests/:id/reject", (req, res) => {
  const pr = reqWithTenant(req.params.id);
  if (!pr) return res.status(404).json({ error: "Request not found" });
  if (!["pending", "awaiting_payment", "payment_reported"].includes(pr.status))
    return res.status(409).json({ error: "This request can't be rejected" });
  db.prepare("UPDATE plan_requests SET status='rejected', review_note=?, updated_at=datetime('now') WHERE id=?")
    .run((req.body?.review_note || "").trim() || null, pr.id);
  res.json(reqWithTenant(pr.id));
});

/** Verify payment and activate the requested plan (→ activated, tier applied). */
router.post("/plan-requests/:id/activate", (req, res) => {
  const pr = reqWithTenant(req.params.id);
  if (!pr) return res.status(404).json({ error: "Request not found" });
  if (!["payment_reported", "awaiting_payment"].includes(pr.status))
    return res.status(409).json({ error: "Approve and await payment before activating" });
  const tier = pr.requested_tier;
  db.transaction(() => {
    // Activating a paid plan ends the free trial (clears the lock for good).
    db.prepare("UPDATE tenants SET tier=?, trial_ends_at=NULL WHERE id=?").run(tier, pr.tenant_id);
    if (tierHasFeature(tier, "accounting")) ensureChart(pr.tenant_id);
    if (tierHasFeature(tier, "multi_user")) ensureRolePermissions(pr.tenant_id);
    if (tierHasFeature(tier, "multi_location")) ensureDefaultLocation(pr.tenant_id);
    db.prepare("UPDATE plan_requests SET status='activated', updated_at=datetime('now') WHERE id=?").run(pr.id);
  })();
  res.json(reqWithTenant(pr.id));
});

/** Count helper, scoped to one tenant. */
function countFor(tenantId, table) {
  return db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE tenant_id = ?`).get(tenantId).n;
}

/** GET /platform/orgs — every (non-platform) organization + headline metrics. */
router.get("/orgs", (req, res) => {
  const tenants = db
    .prepare("SELECT * FROM tenants WHERE is_platform = 0 ORDER BY id")
    .all();
  const rows = tenants.map((t) => ({
    id: t.id,
    name: t.name,
    tier: t.tier,
    active: !!t.active,
    currency: t.base_currency,
    createdAt: t.created_at,
    users: db.prepare("SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND is_platform_admin = 0").get(t.id).n,
    items: countFor(t.id, "items"),
    purchases: countFor(t.id, "purchases"),
    sales: countFor(t.id, "sales"),
    userLimit: USER_LIMITS[t.tier],
    features: featuresForTier(t.tier),
    aiEnabled: !!t.ai_enabled,
  }));
  res.json(rows);
});

/** GET /platform/stats — totals across the platform. */
router.get("/stats", (req, res) => {
  const base = "FROM tenants WHERE is_platform = 0";
  res.json({
    orgs: db.prepare(`SELECT COUNT(*) n ${base}`).get().n,
    active: db.prepare(`SELECT COUNT(*) n ${base} AND active = 1`).get().n,
    suspended: db.prepare(`SELECT COUNT(*) n ${base} AND active = 0`).get().n,
    byTier: {
      basic: db.prepare(`SELECT COUNT(*) n ${base} AND tier='basic'`).get().n,
      standard: db.prepare(`SELECT COUNT(*) n ${base} AND tier='standard'`).get().n,
      premium: db.prepare(`SELECT COUNT(*) n ${base} AND tier='premium'`).get().n,
    },
    users: db.prepare("SELECT COUNT(*) n FROM users WHERE is_platform_admin = 0").get().n,
  });
});

/** GET /platform/orgs/:id — drill-down: org + its users. */
router.get("/orgs/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM tenants WHERE id = ? AND is_platform = 0").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Organization not found" });
  const users = db
    .prepare("SELECT id, name, email, role, active, created_at FROM users WHERE tenant_id = ? AND is_platform_admin = 0 ORDER BY id")
    .all(t.id);
  res.json({ id: t.id, name: t.name, tier: t.tier, active: !!t.active, createdAt: t.created_at, users });
});

/** PATCH /platform/orgs/:id/tier — change an org's plan (grants/revokes features). */
router.patch("/orgs/:id/tier", (req, res) => {
  const { tier } = req.body || {};
  if (!TIERS.includes(tier)) return res.status(400).json({ error: "Invalid tier" });
  const t = db.prepare("SELECT * FROM tenants WHERE id = ? AND is_platform = 0").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Organization not found" });

  // A super-admin directly granting a plan also ends any running trial.
  db.prepare("UPDATE tenants SET tier = ?, trial_ends_at = NULL WHERE id = ?").run(tier, t.id);
  // Seed tier scaffolding on upgrade (idempotent), mirroring owner self-upgrade.
  if (tierHasFeature(tier, "accounting")) ensureChart(t.id);
  if (tierHasFeature(tier, "multi_user")) ensureRolePermissions(t.id);
  if (tierHasFeature(tier, "multi_location")) ensureDefaultLocation(t.id);
  res.json({ id: t.id, tier, features: featuresForTier(tier), userLimit: USER_LIMITS[tier] });
});

/** PATCH /platform/orgs/:id/ai — grant/revoke the paid AI-assistant add-on.
 *  The add-on is billed separately from the plan, so only the super admin can
 *  switch it on (after payment) or off — tenants cannot self-enable. */
router.patch("/orgs/:id/ai", (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) required" });
  const t = db.prepare("SELECT * FROM tenants WHERE id = ? AND is_platform = 0").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Organization not found" });
  db.prepare("UPDATE tenants SET ai_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, t.id);
  res.json({ id: t.id, aiEnabled: enabled });
});

/** PATCH /platform/orgs/:id/status — suspend or restore an org's access. */
router.patch("/orgs/:id/status", (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== "boolean") return res.status(400).json({ error: "active (boolean) required" });
  const t = db.prepare("SELECT * FROM tenants WHERE id = ? AND is_platform = 0").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Organization not found" });
  db.prepare("UPDATE tenants SET active = ? WHERE id = ?").run(active ? 1 : 0, t.id);
  res.json({ id: t.id, active });
});

module.exports = router;
