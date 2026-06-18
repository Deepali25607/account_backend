/**
 * Subscription plan pricing — a single platform-wide price list managed by the
 * super admin. Tenants read it (e.g. on the Billing screen); only the platform
 * console can change it.
 */
const db = require("./db");

const ORDER = "CASE tier WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END";
const DEFAULTS = {
  basic:    { price_monthly: 499,  price_yearly: 4990,  currency: "INR" },
  standard: { price_monthly: 1499, price_yearly: 14990, currency: "INR" },
  premium:  { price_monthly: 3999, price_yearly: 39990, currency: "INR" },
};

/** Seed default prices once (idempotent). */
function ensurePricing() {
  const ins = db.prepare("INSERT OR IGNORE INTO plan_pricing (tier, price_monthly, price_yearly, currency) VALUES (?,?,?,?)");
  for (const [tier, p] of Object.entries(DEFAULTS)) ins.run(tier, p.price_monthly, p.price_yearly, p.currency);
}

function getPricing() {
  ensurePricing();
  return db.prepare(`SELECT tier, price_monthly, price_yearly, currency, updated_at FROM plan_pricing ORDER BY ${ORDER}`).all();
}

function setPricing(tier, { price_monthly, price_yearly, currency }) {
  ensurePricing();
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
  db.prepare("UPDATE plan_pricing SET price_monthly=?, price_yearly=?, currency=?, updated_at=datetime('now') WHERE tier=?")
    .run(n(price_monthly), n(price_yearly), (currency || "INR").toString().slice(0, 4).toUpperCase(), tier);
  return db.prepare("SELECT tier, price_monthly, price_yearly, currency, updated_at FROM plan_pricing WHERE tier=?").get(tier);
}

module.exports = { ensurePricing, getPricing, setPricing, DEFAULTS };
