/**
 * In a non-text, explicitly available-only search, the availability facet is
 * computed from the SAME base candidate CTE as the normal rights-scoped
 * COUNT. Its grouped available row is therefore the exact display-only total.
 *
 * Never infer totals from disjunctive category/language/publisher facets:
 * those deliberately omit their own filters and have a different population.
 * This result never authorizes book disclosure; live primary-rights candidate
 * selection, details, checkout and protected delivery remain independent.
 */
export function countAvailableCandidatesFromFacet(
  input: { query: string; availability?: string },
  hasFts: boolean,
  facets: { availability: Array<{ value: string; count: number }> },
): number | null {
  if (input.query || input.availability !== "available" || hasFts) return null;
  if (!Array.isArray(facets?.availability)) return null;
  if (facets.availability.length === 0) return 0;
  if (facets.availability.length !== 1) return null;
  const only = facets.availability[0];
  if (only.value !== "available" || !Number.isSafeInteger(only.count) || only.count < 0)
    return null;
  return only.count;
}
