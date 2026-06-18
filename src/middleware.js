const jwt = require("jsonwebtoken");
const db = require("./db");
const { tierHasFeature } = require("./entitlements");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

function signToken(user) {
  return jwt.sign(
    { uid: user.id, tid: user.tenant_id, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

/** Authenticate via Bearer token; loads fresh user + tenant onto req. */
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db
      .prepare("SELECT id, tenant_id, name, email, role, active, is_platform_admin FROM users WHERE id = ?")
      .get(payload.uid);
    if (!user || !user.active) return res.status(401).json({ error: "Invalid user" });
    const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(user.tenant_id);
    // A platform admin is exempt; a normal user of a suspended org is locked out.
    if (!user.is_platform_admin && tenant && tenant.active === 0)
      return res.status(403).json({ error: "org_suspended", message: "This organization has been suspended. Contact the platform administrator." });
    req.user = user;
    req.tenant = tenant;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Block access to a module not included in the tenant's tier (§5.2). */
function requireFeature(feature) {
  return (req, res, next) => {
    if (!tierHasFeature(req.tenant.tier, feature)) {
      return res.status(403).json({
        error: "feature_not_in_tier",
        feature,
        tier: req.tenant.tier,
        message: `Your ${req.tenant.tier} plan does not include ${feature}. Upgrade to unlock it.`,
      });
    }
    next();
  };
}

/** Gate the platform-operator console: only super-admins (cross-tenant). */
function requirePlatformAdmin(req, res, next) {
  if (!req.user || !req.user.is_platform_admin)
    return res.status(403).json({ error: "platform_admin_only" });
  next();
}

/** Restrict to specific roles (RBAC, UM-02/UM-03). Owner always allowed. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user.role === "owner" || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: "insufficient_role" });
  };
}

function logAction(req, action, entity, entityId) {
  db.prepare(
    "INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id) VALUES (?,?,?,?,?)"
  ).run(req.tenant.id, req.user.id, action, entity || null, entityId || null);
}

module.exports = { signToken, auth, requireFeature, requireRole, requirePlatformAdmin, logAction, JWT_SECRET };
