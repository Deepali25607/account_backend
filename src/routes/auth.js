const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken, auth, requireRole, logAction } = require("../middleware");
const { featuresForTier, USER_LIMITS, tierHasFeature } = require("../entitlements");
const { ensureChart } = require("../accounting");
const { ensureRolePermissions } = require("../permissions");
const { ensureDefaultLocation } = require("../locations");

const router = express.Router();

/** POST /api/auth/register — create a company (tenant) + owner user. */
router.post("/register", (req, res) => {
  const { company, name, email, password, tier } = req.body || {};
  if (!company || !name || !email || !password)
    return res.status(400).json({ error: "company, name, email, password are required" });

  const chosenTier = ["basic", "standard", "premium"].includes(tier) ? tier : "basic";
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return res.status(409).json({ error: "Email already registered" });

  const tx = db.transaction(() => {
    const t = db
      .prepare("INSERT INTO tenants (name, tier) VALUES (?, ?)")
      .run(company, chosenTier);
    const hash = bcrypt.hashSync(password, 10);
    const u = db
      .prepare(
        "INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,'owner')"
      )
      .run(t.lastInsertRowid, name, email, hash);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(u.lastInsertRowid);
  });

  const user = tx();
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(user.tenant_id);
  if (tierHasFeature(tenant.tier, "accounting")) ensureChart(tenant.id);
  if (tierHasFeature(tenant.tier, "multi_user")) ensureRolePermissions(tenant.id);
  if (tierHasFeature(tenant.tier, "multi_location")) ensureDefaultLocation(tenant.id);
  res.status(201).json({ token: signToken(user), ...publicMe(user, tenant) });
});

/** POST /api/auth/login */
router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email || "");
  if (!user || !bcrypt.compareSync(password || "", user.password_hash))
    return res.status(401).json({ error: "Invalid email or password" });
  if (!user.active) return res.status(403).json({ error: "Account disabled" });
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(user.tenant_id);
  if (!user.is_platform_admin && tenant && tenant.active === 0)
    return res.status(403).json({ error: "This organization has been suspended. Contact the platform administrator." });
  res.json({ token: signToken(user), ...publicMe(user, tenant) });
});

/** GET /api/me — current user, tenant, tier & feature flags for the UI. */
router.get("/me", auth, (req, res) => {
  res.json(publicMe(req.user, req.tenant));
});

/**
 * PUT /api/me/company — update the company profile (owner only).
 * Lets the account owner maintain the business's legal details (name, address,
 * GSTIN, contact) that print on invoices/receipts and GST documents.
 */
router.put("/me/company", auth, requireRole(), (req, res) => {
  const b = req.body || {};
  const name = String(b.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Company name is required" });
  // Whitelist the editable profile fields; trim text, drop everything else.
  const text = (v) => { const s = String(v ?? "").trim(); return s || null; };
  // Logo is an inline image data-URL (or "" to remove). Cap size and require an
  // image/* data-URL so we never persist arbitrary blobs.
  const logoRaw = String(b.logo ?? "").trim();
  if (logoRaw && !/^data:image\/[a-z+.-]+;base64,/i.test(logoRaw))
    return res.status(400).json({ error: "Logo must be an image" });
  if (logoRaw.length > 1_500_000) return res.status(400).json({ error: "Logo image is too large (max ~1 MB)" });
  const fields = {
    name,
    gstin: text(b.gstin),
    pan: text(b.pan),
    phone: text(b.phone),
    email: text(b.email),
    website: text(b.website),
    address: text(b.address),
    city: text(b.city),
    state: text(b.state),
    pincode: text(b.pincode),
    logo: logoRaw || null,
  };
  db.prepare(
    `UPDATE tenants SET name=@name, gstin=@gstin, pan=@pan, phone=@phone, email=@email,
       website=@website, address=@address, city=@city, state=@state, pincode=@pincode, logo=@logo
     WHERE id=@id`
  ).run({ ...fields, id: req.tenant.id });
  logAction(req, "update", "company", req.tenant.id);
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(req.tenant.id);
  res.json(publicMe(req.user, tenant));
});

/** GET /api/auth/pricing — current plan price list (read-only for tenants). */
router.get("/pricing", auth, (req, res) => {
  res.json(require("../pricing").getPricing());
});

/** POST /api/auth/coupon/validate — check a coupon and return its discount. */
router.post("/coupon/validate", auth, (req, res) => {
  const code = (req.body?.code || "").toString().trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Enter a coupon code" });
  const c = db.prepare("SELECT * FROM coupons WHERE code=?").get(code);
  if (!c || !c.active) return res.status(404).json({ error: "Invalid or inactive coupon code" });
  if (c.expires_at && c.expires_at < new Date().toISOString().slice(0, 10))
    return res.status(400).json({ error: "This coupon has expired" });
  if (c.max_redemptions > 0 && c.times_redeemed >= c.max_redemptions)
    return res.status(400).json({ error: "This coupon has reached its redemption limit" });
  res.json({ valid: true, code: c.code, description: c.description, discount_type: c.discount_type, discount_value: c.discount_value, applies_to: c.applies_to });
});

/** PATCH /api/me/tier — DISABLED. Plan changes now go through an upgrade request
 *  reviewed and activated by the platform super admin (manual payment workflow). */
router.patch("/me/tier", auth, (req, res) => {
  return res.status(403).json({
    error: "Direct plan changes are disabled. Submit an upgrade request for super-admin approval.",
  });
});

function publicMe(user, tenant) {
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    tenant: {
      id: tenant.id, name: tenant.name, tier: tenant.tier, currency: tenant.base_currency,
      gstin: tenant.gstin || "", pan: tenant.pan || "", phone: tenant.phone || "", email: tenant.email || "",
      website: tenant.website || "", address: tenant.address || "", city: tenant.city || "",
      state: tenant.state || "", pincode: tenant.pincode || "", logo: tenant.logo || "",
    },
    features: featuresForTier(tenant.tier),
    userLimit: USER_LIMITS[tenant.tier],
    platformAdmin: !!user.is_platform_admin,
  };
}

module.exports = router;
