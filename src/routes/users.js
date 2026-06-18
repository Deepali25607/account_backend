const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { auth, requireFeature, logAction } = require("../middleware");
const { USER_LIMITS } = require("../entitlements");
const { MODULES, ACTIONS, ROLES, getMatrix } = require("../permissions");
const { wantsPage, pageParams } = require("../paginate");

const router = express.Router();
router.use(auth);
router.use(requireFeature("multi_user")); // Standard & Premium (Basic = single user, UM-05)

// Only the owner administers the team.
const ownerOnly = (req, res, next) =>
  req.user.role === "owner" ? next() : res.status(403).json({ error: "Only the owner can manage the team" });

const VALID_ROLES = ["owner", "accountant", "sales", "purchase", "production"];

/** UM-01: list named users under the subscription, with the plan's limit. */
router.get("/", (req, res) => {
  const users = db.prepare(
    "SELECT id, name, email, role, active, created_at FROM users WHERE tenant_id=? ORDER BY role='owner' DESC, name"
  ).all(req.tenant.id);
  const activeCount = users.filter((u) => u.active).length;
  res.json({ users, limit: USER_LIMITS[req.tenant.tier], activeCount });
});

/** Invite a user: owner sets an initial password to share. Enforces user limit. */
router.post("/", ownerOnly, (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "name, email, password are required" });
  if (!VALID_ROLES.includes(role) || role === "owner") return res.status(400).json({ error: "Invalid role" });
  if (role === "production" && req.tenant.tier !== "premium")
    return res.status(400).json({ error: "Production Staff role requires the Premium plan" });

  const active = db.prepare("SELECT COUNT(*) c FROM users WHERE tenant_id=? AND active=1").get(req.tenant.id).c;
  if (active >= USER_LIMITS[req.tenant.tier])
    return res.status(403).json({ error: `Your ${req.tenant.tier} plan allows ${USER_LIMITS[req.tenant.tier]} active user(s). Upgrade to add more.` });
  if (db.prepare("SELECT id FROM users WHERE email=?").get(email)) return res.status(409).json({ error: "Email already registered" });

  const r = db.prepare(
    "INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?)"
  ).run(req.tenant.id, name, email, bcrypt.hashSync(password, 10), role);
  logAction(req, "create", "user", r.lastInsertRowid);
  res.status(201).json(db.prepare("SELECT id, name, email, role, active FROM users WHERE id=?").get(r.lastInsertRowid));
});

/** Update role and/or active state. Guards against owner self-lockout. */
router.put("/:id", ownerOnly, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!u) return res.status(404).json({ error: "Not found" });
  if (u.role === "owner") return res.status(400).json({ error: "The owner account cannot be modified here" });
  const { role, active } = req.body || {};
  if (role !== undefined && (!VALID_ROLES.includes(role) || role === "owner")) return res.status(400).json({ error: "Invalid role" });

  if (active === 1 || active === true) {
    const cnt = db.prepare("SELECT COUNT(*) c FROM users WHERE tenant_id=? AND active=1").get(req.tenant.id).c;
    if (!u.active && cnt >= USER_LIMITS[req.tenant.tier]) return res.status(403).json({ error: "User limit reached" });
  }
  db.prepare("UPDATE users SET role=?, active=? WHERE id=?")
    .run(role ?? u.role, active === undefined ? u.active : active ? 1 : 0, u.id);
  logAction(req, "update", "user", u.id);
  res.json(db.prepare("SELECT id, name, email, role, active FROM users WHERE id=?").get(u.id));
});

/** Deactivate a user (soft — preserves audit history). */
router.delete("/:id", ownerOnly, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!u) return res.status(404).json({ error: "Not found" });
  if (u.role === "owner") return res.status(400).json({ error: "Cannot deactivate the owner" });
  db.prepare("UPDATE users SET active=0 WHERE id=?").run(u.id);
  logAction(req, "deactivate", "user", u.id);
  res.json({ ok: true });
});

/* ── UM-03: role permission matrix ── */
router.get("/permissions", (req, res) => {
  res.json({ modules: MODULES, actions: ACTIONS, roles: ROLES, matrix: getMatrix(req.tenant.id) });
});

router.put("/permissions", ownerOnly, (req, res) => {
  const { changes } = req.body || {}; // [{role, module, can_view, ...}]
  if (!Array.isArray(changes)) return res.status(400).json({ error: "changes array required" });
  const up = db.prepare(
    `UPDATE role_permissions SET can_view=?, can_create=?, can_edit=?, can_approve=?, can_delete=?
     WHERE tenant_id=? AND role=? AND module=?`
  );
  const tx = db.transaction(() => {
    for (const c of changes) {
      if (c.role === "owner") continue;
      up.run(b(c.can_view), b(c.can_create), b(c.can_edit), b(c.can_approve), b(c.can_delete), req.tenant.id, c.role, c.module);
    }
  });
  tx();
  logAction(req, "update", "permissions", null);
  res.json(getMatrix(req.tenant.id));
});

/* ── UM-04: audit trail ── */
router.get("/audit", ownerOnly, (req, res) => {
  const sel = `SELECT a.id, a.action, a.entity, a.entity_id, a.created_at, u.name AS user_name, u.role
               FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.tenant_id=?`;
  if (wantsPage(req)) {
    const { page, pageSize, offset } = pageParams(req);
    const total = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tenant_id=?").get(req.tenant.id).c;
    const rows = db.prepare(`${sel} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(req.tenant.id, pageSize, offset);
    return res.json({ rows, total, page, pageSize });
  }
  res.json(db.prepare(`${sel} ORDER BY a.id DESC LIMIT 200`).all(req.tenant.id));
});

function b(v) { return v ? 1 : 0; }

module.exports = router;
