/**
 * Payment In / Payment Out — AC-06. Available to every tier (receivable/payable
 * tracking is core); ledger posting is added automatically for accounting tiers.
 */
const express = require("express");
const db = require("../db");
const { auth, logAction } = require("../middleware");
const { listPayments, partiesWithBalance, openBills, recordPayment } = require("../payment-service");

const router = express.Router();
router.use(auth);

/** GET /payments?kind=receipt|payment — payment history. */
router.get("/", (req, res) => {
  res.json(listPayments(req.tenant.id, req.query.kind));
});

/** GET /payments/parties?kind=receipt|payment — parties + their open balance. */
router.get("/parties", (req, res) => {
  const kind = req.query.kind === "payment" ? "payment" : "receipt";
  res.json(partiesWithBalance(req.tenant.id, kind));
});

/** GET /payments/bills?kind=receipt|payment&party_id=… — a party's open bills. */
router.get("/bills", (req, res) => {
  const kind = req.query.kind === "payment" ? "payment" : "receipt";
  res.json(openBills(req.tenant.id, kind, Number(req.query.party_id)));
});

/** POST /payments — record a Payment In (receipt) or Payment Out (payment). */
router.post("/", (req, res) => {
  try {
    const result = recordPayment(req.tenant, req.body);
    logAction(req, "create", "payment", result.id);
    const row = db.prepare(
      `SELECT p.*, CASE WHEN p.kind='receipt'
                THEN (SELECT name FROM customers WHERE id=p.party_id)
                ELSE (SELECT name FROM vendors   WHERE id=p.party_id) END AS party_name
       FROM payments p WHERE p.id=?`
    ).get(result.id);
    res.status(201).json({ ...row, allocations: result.allocations, unallocated: result.unallocated, posted: result.posted });
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: e.message });
  }
});

module.exports = router;
