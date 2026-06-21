const express = require("express");
const db = require("../db");
const { auth, requireFeature, logAction } = require("../middleware");
const { recordMovement, num } = require("./masters");
const { tierHasFeature } = require("../entitlements");
const { postPurchase, postSale } = require("../accounting");
const { requirePermission } = require("../permissions");
const { wantsPage, pageParams } = require("../paginate");
const { ensureDefaultLocation, qtyAt, adjustNamed } = require("../locations");

const hasLoc = (tier) => tierHasFeature(tier, "multi_location");
const resolveLocation = (req) => hasLoc(req.tenant.tier) ? (Number(req.body?.location_id) || ensureDefaultLocation(req.tenant.id).id) : null;

const router = express.Router();
router.use(auth);

/* ─────────────────────────── PURCHASES (PU-01..06) ─────────────────────────── */

router.get("/purchases", requireFeature("purchases"), (req, res) => {
  const base = `FROM purchases p JOIN vendors v ON v.id = p.vendor_id WHERE p.tenant_id = ?`;
  const order = " ORDER BY p.doc_date DESC, p.id DESC";
  if (wantsPage(req)) {
    const { page, pageSize, offset } = pageParams(req);
    const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(req.tenant.id).c;
    const rows = db.prepare(`SELECT p.*, v.name AS vendor_name ${base}${order} LIMIT ? OFFSET ?`).all(req.tenant.id, pageSize, offset);
    return res.json({ rows, total, page, pageSize });
  }
  res.json(db.prepare(`SELECT p.*, v.name AS vendor_name ${base}${order}`).all(req.tenant.id));
});

router.get("/purchases/:id", requireFeature("purchases"), (req, res) => {
  const doc = db.prepare("SELECT * FROM purchases WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!doc) return res.status(404).json({ error: "Not found" });
  doc.lines = db.prepare(
    `SELECT l.*, i.name AS item_name, i.sku, i.hsn FROM purchase_lines l JOIN items i ON i.id=l.item_id WHERE l.purchase_id=?`
  ).all(doc.id);
  res.json(doc);
});

/**
 * Create a purchase (doc_type 'purchase') or purchase return ('return').
 * Confirmed purchases raise stock and recompute weighted-average cost (IN-05);
 * returns reverse stock and reduce payable (PU-04). Body: { vendor_id, doc_date,
 * doc_type, paid, notes, lines:[{item_id, qty, unit_price, tax_rate}] }
 */
router.post("/purchases", requireFeature("purchases"), requirePermission("purchases", "create"), (req, res) => {
  const { vendor_id, doc_date, doc_type, paid, notes, lines, discount_type, discount_value, extra_charges, extra_charges_note } = req.body || {};
  const type = doc_type === "return" ? "return" : "purchase";
  const payAcct = req.body?.payment_account === "bank" ? "bank" : "cash";
  if (!vendor_id) return res.status(400).json({ error: "vendor_id is required" });
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: "At least one line is required" });

  const locationId = resolveLocation(req);
  const result = db.transaction(() => {
    const totals = computeTotals(lines, req.tenant.tier, { discountType: discount_type, discountValue: discount_value, charges: extra_charges });
    const docNo = nextDocNo("purchases", type === "return" ? "PR" : "PO", req.tenant.id);
    const paidAmt = Math.min(num(paid), totals.grand); // never record more paid than the bill total
    const p = db
      .prepare(
        `INSERT INTO purchases (tenant_id, vendor_id, doc_no, doc_type, doc_date, status, subtotal, tax_total, discount, discount_type, discount_value, extra_charges, extra_charges_note, grand_total, paid, notes, location_id, payment_account)
         VALUES (?,?,?,?,?,'confirmed',?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(req.tenant.id, vendor_id, docNo, type, doc_date || today(),
        totals.subtotal, totals.tax, totals.discount, totals.discount_type, totals.discount_value, totals.charges, chargesNote(extra_charges_note, totals.charges), totals.grand, paidAmt, notes || null, locationId, payAcct);
    for (const ln of totals.lines) {
      db.prepare(
        `INSERT INTO purchase_lines (purchase_id, item_id, qty, unit_price, tax_rate, line_total) VALUES (?,?,?,?,?,?)`
      ).run(p.lastInsertRowid, ln.item_id, ln.qty, ln.unit_price, ln.tax_rate, ln.line_total);
    }
    applyConfirmedPurchase(req.tenant.id, req.tenant.tier, p.lastInsertRowid); // stock + accounting
    // Log the payment made at bill time so it appears in Payments history.
    if (type === "purchase" && paidAmt > 0) {
      db.prepare("INSERT INTO payments (tenant_id, kind, party_id, account, amount, pay_date, note) VALUES (?,?,?,?,?,?,?)")
        .run(req.tenant.id, "payment", vendor_id, payAcct, paidAmt, doc_date || today(), `Paid against ${docNo}`);
    }
    return p.lastInsertRowid;
  })();

  logAction(req, "create", "purchase", result);
  res.status(201).json(db.prepare("SELECT * FROM purchases WHERE id=?").get(result));
});

/**
 * Approve a draft PO (e.g. one generated from MRP, MF-05) — confirms it into
 * stock and the ledger using the same effects as a directly-created purchase.
 */
router.post("/purchases/:id/confirm", requireFeature("purchases"), requirePermission("purchases", "approve"), (req, res) => {
  const p = db.prepare("SELECT * FROM purchases WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  if (p.status !== "draft") return res.status(409).json({ error: `Only draft purchases can be approved (this is '${p.status}')` });
  db.transaction(() => {
    if (req.body && req.body.paid !== undefined) db.prepare("UPDATE purchases SET paid=? WHERE id=?").run(num(req.body.paid), p.id);
    db.prepare("UPDATE purchases SET status='confirmed' WHERE id=?").run(p.id);
    applyConfirmedPurchase(req.tenant.id, req.tenant.tier, p.id);
  })();
  logAction(req, "approve", "purchase", p.id);
  res.json(db.prepare("SELECT * FROM purchases WHERE id=?").get(p.id));
});

/** Cancel a draft PO (no stock/ledger effect). */
router.post("/purchases/:id/cancel", requireFeature("purchases"), requirePermission("purchases", "approve"), (req, res) => {
  const p = db.prepare("SELECT * FROM purchases WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  if (p.status !== "draft") return res.status(409).json({ error: "Only draft purchases can be cancelled" });
  db.prepare("UPDATE purchases SET status='cancelled' WHERE id=?").run(p.id);
  logAction(req, "cancel", "purchase", p.id);
  res.json(db.prepare("SELECT * FROM purchases WHERE id=?").get(p.id));
});

/** Apply a confirmed purchase's stock movements, weighted-avg cost & ledger posting. */
function applyConfirmedPurchase(tenantId, tier, purchaseId) {
  const purchase = db.prepare("SELECT * FROM purchases WHERE id=?").get(purchaseId);
  const sign = purchase.doc_type === "return" ? -1 : 1;
  const lines = db.prepare("SELECT * FROM purchase_lines WHERE purchase_id=?").all(purchaseId);
  for (const ln of lines) {
    const item = db.prepare("SELECT * FROM items WHERE id=? AND tenant_id=?").get(ln.item_id, tenantId);
    if (!item) throw httpError(400, `Item ${ln.item_id} not found`);
    if (purchase.doc_type === "purchase") {
      const newQty = item.stock_qty + ln.qty;
      const newCost = newQty > 0 ? (item.stock_qty * item.cost_price + ln.qty * ln.unit_price) / newQty : ln.unit_price;
      db.prepare("UPDATE items SET stock_qty = stock_qty + ?, cost_price = ? WHERE id=?").run(ln.qty, round(newCost), item.id);
    } else {
      db.prepare("UPDATE items SET stock_qty = stock_qty + ? WHERE id=?").run(sign * ln.qty, item.id);
    }
    recordMovement(tenantId, item.id, sign * ln.qty, purchase.doc_type === "return" ? "purchase_return" : "purchase", "purchase", purchaseId);
    if (hasLoc(tier) && purchase.location_id) adjustNamed(tenantId, item.id, purchase.location_id, sign * ln.qty); // IN-06: goods into chosen warehouse
  }
  if (tierHasFeature(tier, "accounting")) postPurchase(tenantId, purchase); // AC-01
}

/**
 * Edit a purchase (admin/can_edit). A confirmed purchase has already moved stock,
 * recomputed weighted-avg cost and posted the ledger, so we reverse those effects,
 * replace the lines/totals, then re-apply — all in one transaction.
 * NOTE: the avg-cost reversal is exact when this is the latest cost-affecting event
 * for an item; later movements can leave the re-derived cost slightly shifted.
 */
router.put("/purchases/:id", requireFeature("purchases"), requirePermission("purchases", "edit"), (req, res) => {
  const p = db.prepare("SELECT * FROM purchases WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  const { vendor_id, doc_date, doc_type, paid, notes, lines, discount_type, discount_value, extra_charges, extra_charges_note } = req.body || {};
  const type = doc_type === "return" ? "return" : "purchase";
  const payAcct = req.body?.payment_account === "bank" ? "bank" : "cash";
  if (!vendor_id) return res.status(400).json({ error: "vendor_id is required" });
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: "At least one line is required" });

  const newLocation = resolveLocation(req);
  try {
    db.transaction(() => {
      const oldLines = db.prepare("SELECT * FROM purchase_lines WHERE purchase_id=?").all(p.id);
      if (p.status === "confirmed") reversePurchaseEffects(req.tenant.id, req.tenant.tier, p, oldLines);

      const totals = computeTotals(lines, req.tenant.tier, { discountType: discount_type, discountValue: discount_value, charges: extra_charges });
      const paidAmt = Math.min(num(paid), totals.grand);
      db.prepare(
        `UPDATE purchases SET vendor_id=?, doc_type=?, doc_date=?, subtotal=?, tax_total=?, discount=?, discount_type=?, discount_value=?, extra_charges=?, extra_charges_note=?, grand_total=?, paid=?, notes=?, location_id=?, payment_account=? WHERE id=?`
      ).run(vendor_id, type, doc_date || p.doc_date, totals.subtotal, totals.tax, totals.discount, totals.discount_type, totals.discount_value, totals.charges, chargesNote(extra_charges_note, totals.charges), totals.grand, paidAmt, notes || null, newLocation, payAcct, p.id);
      db.prepare("DELETE FROM purchase_lines WHERE purchase_id=?").run(p.id);
      for (const ln of totals.lines) {
        db.prepare(`INSERT INTO purchase_lines (purchase_id, item_id, qty, unit_price, tax_rate, line_total) VALUES (?,?,?,?,?,?)`)
          .run(p.id, ln.item_id, ln.qty, ln.unit_price, ln.tax_rate, ln.line_total);
      }
      if (p.status === "confirmed") {
        applyConfirmedPurchase(req.tenant.id, req.tenant.tier, p.id); // stock + cost + ledger
        if (type === "purchase" && paidAmt > 0) {
          db.prepare("INSERT INTO payments (tenant_id, kind, party_id, account, amount, pay_date, note) VALUES (?,?,?,?,?,?,?)")
            .run(req.tenant.id, "payment", vendor_id, payAcct, paidAmt, doc_date || p.doc_date, `Paid against ${p.doc_no}`);
        }
      }
    })();
    logAction(req, "edit", "purchase", p.id);
    res.json(db.prepare("SELECT * FROM purchases WHERE id=?").get(p.id));
  } catch (e) {
    if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
    throw e;
  }
});

/* ─────────────────────────── SALES (SA-01..06) ─────────────────────────── */

router.get("/sales", requireFeature("sales"), (req, res) => {
  const base = `FROM sales s JOIN customers c ON c.id = s.customer_id WHERE s.tenant_id = ?`;
  const order = " ORDER BY s.doc_date DESC, s.id DESC";
  if (wantsPage(req)) {
    const { page, pageSize, offset } = pageParams(req);
    const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(req.tenant.id).c;
    const rows = db.prepare(`SELECT s.*, c.name AS customer_name ${base}${order} LIMIT ? OFFSET ?`).all(req.tenant.id, pageSize, offset);
    return res.json({ rows, total, page, pageSize });
  }
  res.json(db.prepare(`SELECT s.*, c.name AS customer_name ${base}${order}`).all(req.tenant.id));
});

router.get("/sales/:id", requireFeature("sales"), (req, res) => {
  const doc = db.prepare("SELECT * FROM sales WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!doc) return res.status(404).json({ error: "Not found" });
  doc.lines = db.prepare(
    `SELECT l.*, i.name AS item_name, i.sku, i.hsn FROM sale_lines l JOIN items i ON i.id=l.item_id WHERE l.sale_id=?`
  ).all(doc.id);
  res.json(doc);
});

/**
 * Create a sale ('sale') or sales return ('return'). Sales reduce stock (SA-04),
 * block overselling unless allowOverride (SA-05), and capture COGS for profit
 * reporting (RP-05). Returns add stock back and reduce receivable (SA-03).
 */
router.post("/sales", requireFeature("sales"), requirePermission("sales", "create"), (req, res) => {
  const { customer_id, doc_date, doc_type, received, notes, lines, allowOverride, discount_type, discount_value, extra_charges, extra_charges_note } = req.body || {};
  const type = doc_type === "return" ? "return" : "sale";
  const payAcct = req.body?.payment_account === "bank" ? "bank" : "cash";
  if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: "At least one line is required" });

  const locationId = resolveLocation(req);
  try {
    const result = db.transaction(() => {
      const totals = computeTotals(lines, req.tenant.tier, { discountType: discount_type, discountValue: discount_value, charges: extra_charges });
      const docNo = nextDocNo("sales", type === "return" ? "CN" : "INV", req.tenant.id);
      const recv = Math.min(num(received), totals.grand); // never record more received than the invoice total
      const s = db
        .prepare(
          `INSERT INTO sales (tenant_id, customer_id, doc_no, doc_type, doc_date, subtotal, tax_total, discount, discount_type, discount_value, extra_charges, extra_charges_note, grand_total, received, cogs, notes, location_id, payment_account)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(req.tenant.id, customer_id, docNo, type, doc_date || today(),
          totals.subtotal, totals.tax, totals.discount, totals.discount_type, totals.discount_value, totals.charges, chargesNote(extra_charges_note, totals.charges), totals.grand, recv, 0, notes || null, locationId, payAcct);

      for (const ln of totals.lines) {
        db.prepare(
          `INSERT INTO sale_lines (sale_id, item_id, qty, unit_price, tax_rate, line_total) VALUES (?,?,?,?,?,?)`
        ).run(s.lastInsertRowid, ln.item_id, ln.qty, ln.unit_price, ln.tax_rate, ln.line_total);
      }
      applyConfirmedSale(req.tenant.id, req.tenant.tier, s.lastInsertRowid, allowOverride); // stock + COGS + ledger
      // Log the payment received at invoice time so it appears in Payments history
      // (informational — the ledger leg is already posted above; not re-allocated).
      if (type === "sale" && recv > 0) {
        db.prepare("INSERT INTO payments (tenant_id, kind, party_id, account, amount, pay_date, note) VALUES (?,?,?,?,?,?,?)")
          .run(req.tenant.id, "receipt", customer_id, payAcct, recv, doc_date || today(), `Received against ${docNo}`);
      }
      return s.lastInsertRowid;
    })();

    logAction(req, "create", "sale", result);
    res.status(201).json(db.prepare("SELECT * FROM sales WHERE id=?").get(result));
  } catch (e) {
    if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
    throw e;
  }
});

/**
 * Apply a sale's effects (SA-04/05, RP-05, AC-01): issue stock from the chosen
 * location, capture COGS at weighted-avg cost, and post the ledger. Operates on a
 * sale row + its lines already in the DB. Shared by create and edit.
 */
function applyConfirmedSale(tenantId, tier, saleId, allowOverride) {
  const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(saleId);
  const sign = sale.doc_type === "return" ? 1 : -1; // sale removes stock, return adds back
  const lines = db.prepare("SELECT * FROM sale_lines WHERE sale_id=?").all(saleId);
  let cogs = 0;
  for (const ln of lines) {
    const item = db.prepare("SELECT * FROM items WHERE id=? AND tenant_id=?").get(ln.item_id, tenantId);
    if (!item) throw httpError(400, `Item ${ln.item_id} not found`);
    if (sale.doc_type === "sale" && !allowOverride) {
      const available = hasLoc(tier) && sale.location_id ? qtyAt(tenantId, item.id, sale.location_id) : item.stock_qty;
      if (ln.qty > available) throw httpError(409, `Insufficient stock for ${item.name} (have ${available}, need ${ln.qty})`);
    }
    const delta = sign * ln.qty;
    db.prepare("UPDATE items SET stock_qty = stock_qty + ? WHERE id=?").run(delta, item.id);
    if (hasLoc(tier) && sale.location_id) adjustNamed(tenantId, item.id, sale.location_id, delta);
    cogs += ln.qty * item.cost_price * (sale.doc_type === "sale" ? 1 : -1);
    recordMovement(tenantId, item.id, delta, sale.doc_type === "return" ? "sale_return" : "sale", "sale", saleId);
  }
  db.prepare("UPDATE sales SET cogs=? WHERE id=?").run(round(cogs), saleId);
  if (tierHasFeature(tier, "accounting")) postSale(tenantId, db.prepare("SELECT * FROM sales WHERE id=?").get(saleId));
}

/**
 * Edit a sale (admin/can_edit). Reverses the original's stock issue, COGS and
 * ledger postings, replaces the lines/totals, then re-applies — in one transaction.
 */
router.put("/sales/:id", requireFeature("sales"), requirePermission("sales", "edit"), (req, res) => {
  const s = db.prepare("SELECT * FROM sales WHERE id=? AND tenant_id=?").get(req.params.id, req.tenant.id);
  if (!s) return res.status(404).json({ error: "Not found" });
  const { customer_id, doc_date, doc_type, received, notes, lines, allowOverride, discount_type, discount_value, extra_charges, extra_charges_note } = req.body || {};
  const type = doc_type === "return" ? "return" : "sale";
  const payAcct = req.body?.payment_account === "bank" ? "bank" : "cash";
  if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: "At least one line is required" });

  const newLocation = resolveLocation(req);
  try {
    db.transaction(() => {
      const oldLines = db.prepare("SELECT * FROM sale_lines WHERE sale_id=?").all(s.id);
      reverseSaleEffects(req.tenant.id, req.tenant.tier, s, oldLines);

      const totals = computeTotals(lines, req.tenant.tier, { discountType: discount_type, discountValue: discount_value, charges: extra_charges });
      const recv = Math.min(num(received), totals.grand);
      db.prepare(
        `UPDATE sales SET customer_id=?, doc_type=?, doc_date=?, subtotal=?, tax_total=?, discount=?, discount_type=?, discount_value=?, extra_charges=?, extra_charges_note=?, grand_total=?, received=?, cogs=0, notes=?, location_id=?, payment_account=? WHERE id=?`
      ).run(customer_id, type, doc_date || s.doc_date, totals.subtotal, totals.tax, totals.discount, totals.discount_type, totals.discount_value, totals.charges, chargesNote(extra_charges_note, totals.charges), totals.grand, recv, notes || null, newLocation, payAcct, s.id);
      db.prepare("DELETE FROM sale_lines WHERE sale_id=?").run(s.id);
      for (const ln of totals.lines) {
        db.prepare(`INSERT INTO sale_lines (sale_id, item_id, qty, unit_price, tax_rate, line_total) VALUES (?,?,?,?,?,?)`)
          .run(s.id, ln.item_id, ln.qty, ln.unit_price, ln.tax_rate, ln.line_total);
      }
      applyConfirmedSale(req.tenant.id, req.tenant.tier, s.id, allowOverride); // stock + COGS + ledger
      if (type === "sale" && recv > 0) {
        db.prepare("INSERT INTO payments (tenant_id, kind, party_id, account, amount, pay_date, note) VALUES (?,?,?,?,?,?,?)")
          .run(req.tenant.id, "receipt", customer_id, payAcct, recv, doc_date || s.doc_date, `Received against ${s.doc_no}`);
      }
    })();
    logAction(req, "edit", "sale", s.id);
    res.json(db.prepare("SELECT * FROM sales WHERE id=?").get(s.id));
  } catch (e) {
    if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
    throw e;
  }
});

/* ─────────────────────────── edit reversal helpers ─────────────────────────── */

/** Delete the journal entries (and their lines) posted for a document. */
function deleteJournalByRef(tenantId, refType, refId) {
  const entries = db.prepare("SELECT id FROM journal_entries WHERE tenant_id=? AND ref_type=? AND ref_id=?").all(tenantId, refType, refId);
  for (const e of entries) {
    db.prepare("DELETE FROM journal_lines WHERE entry_id=?").run(e.id);
    db.prepare("DELETE FROM journal_entries WHERE id=?").run(e.id);
  }
}

/** Remove the auto-logged payment row created at bill time (matched by its note). */
function deleteDocPayments(tenantId, note) {
  db.prepare("DELETE FROM payments WHERE tenant_id=? AND note=?").run(tenantId, note);
}

/** Undo a confirmed purchase's stock, weighted-avg cost, location, ledger & payment. */
function reversePurchaseEffects(tenantId, tier, purchase, lines) {
  // Reverse in the opposite order to how create applied the running weighted average.
  for (const ln of [...lines].reverse()) {
    const item = db.prepare("SELECT * FROM items WHERE id=? AND tenant_id=?").get(ln.item_id, tenantId);
    if (!item) continue;
    if (purchase.doc_type === "purchase") {
      const prevQty = round(item.stock_qty - ln.qty);
      const prevCost = prevQty > 0 ? round((item.stock_qty * item.cost_price - ln.qty * ln.unit_price) / prevQty) : item.cost_price;
      db.prepare("UPDATE items SET stock_qty=?, cost_price=? WHERE id=?").run(prevQty, prevCost, item.id);
      recordMovement(tenantId, item.id, -ln.qty, "edit_reversal", "purchase", purchase.id, `Reversed for edit of ${purchase.doc_no}`);
      if (hasLoc(tier) && purchase.location_id) adjustNamed(tenantId, item.id, purchase.location_id, -ln.qty);
    } else { // return originally removed stock (sign -1)
      db.prepare("UPDATE items SET stock_qty = stock_qty + ? WHERE id=?").run(ln.qty, item.id);
      recordMovement(tenantId, item.id, ln.qty, "edit_reversal", "purchase", purchase.id, `Reversed for edit of ${purchase.doc_no}`);
      if (hasLoc(tier) && purchase.location_id) adjustNamed(tenantId, item.id, purchase.location_id, ln.qty);
    }
  }
  deleteJournalByRef(tenantId, "purchase", purchase.id);
  deleteDocPayments(tenantId, `Paid against ${purchase.doc_no}`);
}

/** Undo a sale's stock issue, location moves, ledger (sale + COGS) & receipt. */
function reverseSaleEffects(tenantId, tier, sale, lines) {
  const origSign = sale.doc_type === "return" ? 1 : -1; // delta create applied
  for (const ln of lines) {
    const item = db.prepare("SELECT * FROM items WHERE id=? AND tenant_id=?").get(ln.item_id, tenantId);
    if (!item) continue;
    const delta = origSign * ln.qty;
    db.prepare("UPDATE items SET stock_qty = stock_qty - ? WHERE id=?").run(delta, item.id);
    if (hasLoc(tier) && sale.location_id) adjustNamed(tenantId, item.id, sale.location_id, -delta);
    recordMovement(tenantId, item.id, -delta, "edit_reversal", "sale", sale.id, `Reversed for edit of ${sale.doc_no}`);
  }
  deleteJournalByRef(tenantId, "sale", sale.id);
  deleteJournalByRef(tenantId, "sale_cogs", sale.id);
  deleteDocPayments(tenantId, `Received against ${sale.doc_no}`);
}

/* ─────────────────────────── helpers ─────────────────────────── */

/**
 * Compute document totals. The GST rate defaults from the item master
 * (items.tax_rate) when an item is picked on the form, but the user can edit it
 * per line — so we honour the rate submitted on each line. Basic tier is untaxed.
 *
 * Document-level extras (after tax): an additional discount is subtracted and
 * flat additional `charges` (freight/packing) are added, giving
 * grand = subtotal + tax − discount + charges. The discount can be entered as a
 * flat amount (discountType 'amount') or a percentage of the subtotal
 * (discountType 'percent'); the resolved amount is clamped so the grand total
 * never goes negative.
 */
function computeTotals(lines, tier, extras = {}) {
  const taxable = tier !== "basic"; // GST only Standard+ (§5.2)
  let subtotal = 0, tax = 0;
  const out = lines.map((ln) => {
    const qty = num(ln.qty), price = num(ln.unit_price);
    const rate = taxable ? num(ln.tax_rate) : 0;
    const base = qty * price;
    const lineTax = round(base * rate / 100);
    subtotal += base; tax += lineTax;
    return { item_id: ln.item_id, qty, unit_price: price, tax_rate: rate, line_total: round(base + lineTax) };
  });
  const charges = Math.max(0, num(extras.charges));
  const discountType = extras.discountType === "percent" ? "percent" : "amount";
  const discountValue = Math.max(0, num(extras.discountValue));
  const rawDiscount = discountType === "percent"
    ? subtotal * Math.min(discountValue, 100) / 100
    : discountValue;
  const discount = Math.min(rawDiscount, subtotal + tax + charges);
  const grand = subtotal + tax - discount + charges;
  return {
    subtotal: round(subtotal), tax: round(tax),
    discount: round(discount), discount_type: discountType, discount_value: round(discountValue),
    charges: round(charges), grand: round(grand), lines: out,
  };
}
/** Keep an additional-charges note only when charges actually apply; trim/blank → null. */
function chargesNote(note, charges) {
  if (!(round(charges) > 0)) return null;
  const t = String(note ?? "").trim();
  return t || null;
}
function nextDocNo(table, prefix, tenantId) {
  const n = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE tenant_id=?`).get(tenantId).c + 1;
  return `${prefix}-${String(n).padStart(5, "0")}`;
}
function round(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function httpError(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

module.exports = router;
