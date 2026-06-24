const express = require("express");
const { auth, requireRole, logAction } = require("../middleware");
const { exportCompany, importCompany } = require("../backup");

const router = express.Router();
router.use(auth);

/** GET /api/backup/export — download a full company backup (owner only). */
router.get("/export", requireRole(), (req, res) => {
  const dump = exportCompany(req.tenant.id);
  logAction(req, "export", "backup", req.tenant.id);
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = (req.tenant.name || "company").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "company";
  res.setHeader("Content-Disposition", `attachment; filename="${safe}-backup-${stamp}.json"`);
  res.json(dump);
});

/**
 * POST /api/backup/import — restore from a backup, REPLACING all current company
 * data (owner only). The request body is the JSON produced by /export.
 */
router.post("/import", requireRole(), (req, res) => {
  try {
    const counts = importCompany(req.tenant.id, req.body);
    const restored = Object.values(counts).reduce((n, c) => n + c, 0);
    logAction(req, "import", "backup", req.tenant.id);
    res.json({ ok: true, restored, counts });
  } catch (e) {
    res.status(e.httpStatus || 400).json({ error: e.message || "Import failed" });
  }
});

module.exports = router;
