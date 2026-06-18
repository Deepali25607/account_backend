/**
 * Role-based access control — BRD §6.5 (UM-02, UM-03).
 * The owner defines, per role, which modules and actions are allowed. The matrix
 * is stored per-tenant in `role_permissions` and enforced by requirePermission().
 * The Owner role always has full access and bypasses the matrix.
 */
const db = require("./db");

const MODULES = ["inventory", "purchases", "sales", "reports", "accounting", "manufacturing", "users"];
const ACTIONS = ["can_view", "can_create", "can_edit", "can_approve", "can_delete"];
const ROLES = ["accountant", "sales", "purchase", "production"]; // owner is implicit-all

// Sensible starting template (the owner can edit it freely afterwards).
// [view, create, edit, approve, delete]
const DEFAULTS = {
  accountant:  { accounting: [1,1,1,1,0], reports: [1,0,0,0,0], purchases: [1,0,0,1,0], sales: [1,0,0,1,0], inventory: [1,0,0,0,0] },
  sales:       { sales: [1,1,1,0,0], reports: [1,0,0,0,0], inventory: [1,0,0,0,0] },
  purchase:    { purchases: [1,1,1,0,0], inventory: [1,1,1,0,0], reports: [1,0,0,0,0] },
  production:  { manufacturing: [1,1,1,1,0], inventory: [1,0,0,0,0], reports: [1,0,0,0,0] },
};

/** Seed the default matrix for a tenant if it has none. */
function ensureRolePermissions(tenantId) {
  const has = db.prepare("SELECT COUNT(*) c FROM role_permissions WHERE tenant_id=?").get(tenantId).c;
  if (has) return;
  const ins = db.prepare(
    `INSERT INTO role_permissions (tenant_id, role, module, can_view, can_create, can_edit, can_approve, can_delete)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const tx = db.transaction(() => {
    for (const role of ROLES) {
      for (const module of MODULES) {
        const t = DEFAULTS[role]?.[module] || [0, 0, 0, 0, 0];
        ins.run(tenantId, role, module, t[0], t[1], t[2], t[3], t[4]);
      }
    }
  });
  tx();
}

function getMatrix(tenantId) {
  ensureRolePermissions(tenantId);
  return db.prepare("SELECT * FROM role_permissions WHERE tenant_id=? ORDER BY role, module").all(tenantId);
}

function hasPermission(tenantId, role, module, action) {
  if (role === "owner") return true;
  ensureRolePermissions(tenantId);
  const row = db.prepare("SELECT * FROM role_permissions WHERE tenant_id=? AND role=? AND module=?").get(tenantId, role, module);
  return !!(row && row[action]);
}

/** Express middleware enforcing a single module/action (UM-03). */
function requirePermission(module, action) {
  const col = action.startsWith("can_") ? action : `can_${action}`;
  return (req, res, next) => {
    if (hasPermission(req.tenant.id, req.user.role, module, col)) return next();
    return res.status(403).json({ error: "permission_denied", module, action: col, role: req.user.role });
  };
}

module.exports = { MODULES, ACTIONS, ROLES, ensureRolePermissions, getMatrix, hasPermission, requirePermission };
