/**
 * A green selected-row differential is insufficient without tested policy
 * strata. All inputs are aggregate numbers: never product IDs or legal terms.
 * This is a synthetic staging completeness gate, NOT production certification.
 */
export const REQUIRED_RIGHTS_COHORTS = Object.freeze([
  "contract_version",
  "contract_language",
  "nontrivial_drm",
  "contract_bound",
  "explicit_deny",
  "ranked",
]);

export function assertSyntheticRightsDifferentialCoverage(result) {
  if (!result || typeof result !== "object" || result.fullProductionRightsParityCertified !== false)
    throw new Error("Synthetic rights parity provenance is missing");
  if (
    !Number.isSafeInteger(result.checked) ||
    result.checked < 12 ||
    result.checked > 48 ||
    !Number.isSafeInteger(result.canonicalAllowed) ||
    result.canonicalAllowed < 1 ||
    !Number.isSafeInteger(result.denied) ||
    result.denied < 1 ||
    result.canonicalAllowed + result.denied !== result.checked ||
    !Number.isSafeInteger(result.viewAllowed) ||
    result.viewAllowed < 0 ||
    result.viewAllowed > result.checked
  )
    throw new Error("Incomplete synthetic canonical rights comparison");
  if (
    result.mismatchedViewPositive !== 0 ||
    result.mismatchedCanonicalPositive !== 0 ||
    result.advancedPolicyStrataCovered !== true
  )
    throw new Error("Canonical rights parity or required policy strata missing");
  if (!result.policyCohorts || typeof result.policyCohorts !== "object")
    throw new Error("Missing legal policy cohort inventory");
  for (const cohort of REQUIRED_RIGHTS_COHORTS) {
    const entry = result.policyCohorts[cohort];
    if (
      !entry ||
      !Number.isSafeInteger(entry.candidates) ||
      entry.candidates < 1 ||
      !Number.isSafeInteger(entry.uniquelySelected) ||
      entry.uniquelySelected < 1 ||
      entry.uniquelySelected > entry.candidates ||
      entry.candidates > (cohort === "explicit_deny" || cohort === "ranked" ? 24 : 12)
    )
      throw new Error("Required synthetic rights policy cohort not represented");
  }
  return true;
}
