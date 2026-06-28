/**
 * Plan upgrade/downgrade requests — tenant (organization admin) side.
 * Org admins can request a plan change and report payment, but cannot change the
 * plan themselves; activation is done by the platform super admin after manual
 * payment verification. See platform routes for the approval/activation side.
 */
const express = require("express");
const db = require("../db");
const { auth, requireRole, logAction } = require("../middleware");

const router = express.Router();
router.use(auth);

const TIERS = ["basic", "standard", "premium"];
const OPEN = ["pending", "awaiting_payment", "payment_reported"];

/** GET /plan-requests — this org's request history. */
router.get("/", (req, res) => {
  res.json(db.prepare("SELECT * FROM plan_requests WHERE tenant_id=? ORDER BY id DESC").all(req.tenant.id));
});

/** GET /plan-requests/payment-info — platform's manual-payment details (for display). */
router.get("/payment-info", (req, res) => {
  res.json(db.prepare("SELECT upi_id, payee_name, qr_image, instructions FROM platform_payment WHERE id=1").get() || {});
});

/** POST /plan-requests — org admin submits an upgrade/downgrade request. */
router.post("/", requireRole(), (req, res) => {
  const { requested_tier, note } = req.body || {};
  if (!TIERS.includes(requested_tier)) return res.status(400).json({ error: "Invalid plan" });
  // Trial tenants sit on 'premium' but haven't paid, so any tier (incl. the
  // current one) is a valid first subscription. Paid tenants can't re-pick their plan.
  const onTrial = !!req.tenant.trial_ends_at;
  if (!onTrial && requested_tier === req.tenant.tier) return res.status(400).json({ error: "You're already on that plan" });
  const open = db.prepare(`SELECT id FROM plan_requests WHERE tenant_id=? AND status IN ('pending','awaiting_payment','payment_reported')`).get(req.tenant.id);
  if (open) return res.status(409).json({ error: "You already have a request in progress. Please wait for it to be processed." });
  const r = db.prepare(
    "INSERT INTO plan_requests (tenant_id, requested_tier, current_tier, status, note, requested_by) VALUES (?,?,?,'pending',?,?)"
  ).run(req.tenant.id, requested_tier, req.tenant.tier, (note || "").toString().trim() || null, req.user.id);
  logAction(req, "create", "plan_request", r.lastInsertRowid);
  res.status(201).json(db.prepare("SELECT * FROM plan_requests WHERE id=?").get(r.lastInsertRowid));
});

/** POST /plan-requests/:id/report-payment — org admin reports they have paid. */
router.post("/:id/report-payment", requireRole(), (req, res) => {
  const pr = db.prepare("SELECT * FROM plan_requests WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!pr) return res.status(404).json({ error: "Request not found" });
  if (pr.status !== "awaiting_payment") return res.status(409).json({ error: "This request isn't awaiting payment" });
  const ref = (req.body?.reference || "").toString().trim();
  if (!ref) return res.status(400).json({ error: "Enter the payment reference / UTR" });
  db.prepare("UPDATE plan_requests SET status='payment_reported', payment_reference=?, updated_at=datetime('now') WHERE id=?").run(ref, pr.id);
  logAction(req, "report_payment", "plan_request", pr.id);
  res.json(db.prepare("SELECT * FROM plan_requests WHERE id=?").get(pr.id));
});

/** POST /plan-requests/:id/cancel — org admin withdraws an open request. */
router.post("/:id/cancel", requireRole(), (req, res) => {
  const pr = db.prepare("SELECT * FROM plan_requests WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!pr) return res.status(404).json({ error: "Request not found" });
  if (!OPEN.includes(pr.status)) return res.status(409).json({ error: "This request can no longer be cancelled" });
  db.prepare("UPDATE plan_requests SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(pr.id);
  res.json(db.prepare("SELECT * FROM plan_requests WHERE id=?").get(pr.id));
});

module.exports = router;
