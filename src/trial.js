/**
 * Free-trial helpers. Every new company starts on a 14-day full-Premium trial
 * (tenants.trial_ends_at is set at registration). Once a paid plan is activated,
 * trial_ends_at is cleared to NULL and the tenant becomes a normal paid customer.
 */
const TRIAL_DAYS = 14;

// SQLite stores datetime('now', …) as "YYYY-MM-DD HH:MM:SS" in UTC.
function parseUtc(s) {
  return Date.parse(String(s).replace(" ", "T") + "Z");
}

/** Derive the trial state for a tenant row (safe for null/paid tenants). */
function trialStatus(tenant) {
  if (!tenant || !tenant.trial_ends_at)
    return { onTrial: false, expired: false, daysLeft: null, endsAt: null };
  const ends = parseUtc(tenant.trial_ends_at);
  const now = Date.now();
  return {
    onTrial: true,
    expired: now >= ends,
    daysLeft: Math.max(0, Math.ceil((ends - now) / 86_400_000)),
    endsAt: tenant.trial_ends_at,
  };
}

module.exports = { TRIAL_DAYS, trialStatus };
