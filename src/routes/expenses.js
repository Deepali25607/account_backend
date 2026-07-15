/**
 * Business expenses (rent, salaries, utilities, …). Available to every tier —
 * like payments, expense tracking is core. On accounting tiers each expense
 * also posts a balanced ledger entry (Dr 5300 Operating Expenses / Cr Cash or
 * Bank), and deleting the expense removes that entry again.
 */
const express = require("express");
const db = require("../db");
const { auth, logAction } = require("../middleware");
const { ensureChart, postEntry } = require("../accounting");
const { tierHasFeature } = require("../entitlements");

const router = express.Router();
router.use(auth);

const round = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

// Starter suggestions; merged with whatever categories the tenant already used.
const DEFAULT_CATEGORIES = [
  "Rent", "Salaries", "Electricity", "Internet & Phone", "Transport",
  "Repairs & Maintenance", "Office Supplies", "Marketing", "Bank Charges", "Miscellaneous",
];

/** GET /expenses — history, newest first. */
router.get("/", (req, res) => {
  res.json(
    db.prepare(
      `SELECT * FROM expenses WHERE tenant_id=? ORDER BY expense_date DESC, id DESC`
    ).all(req.tenant.id)
  );
});

/** The tenant's categories: created ones + ones used on expenses + starters. */
function categoryList(tenantId) {
  const created = db.prepare(
    `SELECT name FROM expense_categories WHERE tenant_id=? ORDER BY name`
  ).all(tenantId).map((r) => r.name);
  const used = db.prepare(
    `SELECT DISTINCT category FROM expenses WHERE tenant_id=? ORDER BY category`
  ).all(tenantId).map((r) => r.category);
  return [...new Set([...created, ...used, ...DEFAULT_CATEGORIES])];
}

/** GET /expenses/categories — options for the category picker. */
router.get("/categories", (req, res) => {
  res.json(categoryList(req.tenant.id));
});

/** POST /expenses/categories — create a category. Returns the updated list. */
router.post("/categories", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const r = db.prepare(
    "INSERT OR IGNORE INTO expense_categories (tenant_id, name) VALUES (?,?)"
  ).run(req.tenant.id, name);
  if (r.changes) logAction(req, "create", "expense_category", r.lastInsertRowid);
  res.status(r.changes ? 201 : 200).json({ name, categories: categoryList(req.tenant.id) });
});

/** POST /expenses — record an expense. */
router.post("/", (req, res) => {
  const { category, amount, expense_date, account, paid_to, note } = req.body || {};
  const cat = String(category || "").trim();
  const amt = round(amount);
  if (!cat) return res.status(400).json({ error: "category is required" });
  if (!(amt > 0)) return res.status(400).json({ error: "amount must be positive" });
  if (!["cash", "bank"].includes(account)) return res.status(400).json({ error: "account must be cash or bank" });
  const date = expense_date || new Date().toISOString().slice(0, 10);

  const row = db.transaction(() => {
    // Auto-register a newly typed category so it shows up in the picker next time.
    db.prepare("INSERT OR IGNORE INTO expense_categories (tenant_id, name) VALUES (?,?)").run(req.tenant.id, cat);
    const r = db.prepare(
      `INSERT INTO expenses (tenant_id, category, amount, expense_date, account, paid_to, note, created_by)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(req.tenant.id, cat, amt, date, account, paid_to || null, note || null, req.user.id);

    if (tierHasFeature(req.tenant.tier, "accounting")) {
      ensureChart(req.tenant.id);
      postEntry(req.tenant.id,
        { date, memo: `Expense: ${cat} (${account})`, ref_type: "expense", ref_id: r.lastInsertRowid },
        [
          { code: "5300", debit: amt },
          { code: account === "bank" ? "1010" : "1000", credit: amt },
        ]
      );
    }
    return db.prepare("SELECT * FROM expenses WHERE id=?").get(r.lastInsertRowid);
  })();

  logAction(req, "create", "expense", row.id);
  res.status(201).json(row);
});

/** DELETE /expenses/:id — remove an expense and its ledger entry (if any). */
router.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT id FROM expenses WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!row) return res.status(404).json({ error: "Expense not found" });
  db.transaction(() => {
    // journal_lines cascade off journal_entries, so one delete clears the posting
    db.prepare("DELETE FROM journal_entries WHERE tenant_id=? AND ref_type='expense' AND ref_id=?").run(req.tenant.id, row.id);
    db.prepare("DELETE FROM expenses WHERE id=?").run(row.id);
  })();
  logAction(req, "delete", "expense", row.id);
  res.json({ ok: true });
});

module.exports = router;
