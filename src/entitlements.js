/**
 * Tier entitlement layer — BRD §5.2 (Feature Comparison Matrix) and §9
 * constraint 2: "Feature entitlement must be enforceable per the tier matrix
 * ... without maintaining separate codebases per tier."
 *
 * This is the single source of truth. The backend enforces it (requireFeature
 * middleware) and the frontend reads it (/api/me) to drive tier-aware UI.
 * Cumulative by design (§5.3 principle 1): each tier includes the ones below.
 */

const FEATURES = {
  // Basic (all tiers)
  purchases:   ["basic", "standard", "premium"],
  sales:       ["basic", "standard", "premium"],
  inventory:   ["basic", "standard", "premium"],
  reports:     ["basic", "standard", "premium"],
  // Standard +
  multi_user:  ["standard", "premium"],
  accounting:  ["standard", "premium"],
  gst:         ["standard", "premium"],
  // Premium only
  manufacturing: ["premium"],
  multi_location: ["premium"],  // IN-06 multi-warehouse stock tracking
};

const TIER_RANK = { basic: 1, standard: 2, premium: 3 };

// Max named user accounts per tier (UM-05: Basic = single user)
const USER_LIMITS = { basic: 1, standard: 10, premium: 100 };

function tierHasFeature(tier, feature) {
  const tiers = FEATURES[feature];
  return Array.isArray(tiers) && tiers.includes(tier);
}

/** Feature flags for a tier, shaped for the frontend. */
function featuresForTier(tier) {
  const out = {};
  for (const f of Object.keys(FEATURES)) out[f] = tierHasFeature(tier, f);
  return out;
}

module.exports = { FEATURES, TIER_RANK, USER_LIMITS, tierHasFeature, featuresForTier };
