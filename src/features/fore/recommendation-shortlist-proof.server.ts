/**
 * The fast recommendation seed is an INDEXED popularity prefix of the entire
 * catalog, with EVERY global/territorial metric override explicitly added.
 * It is an EXACT replacement for full-catalog ranking only if the last
 * rights-authorized result strictly outranks the unseen indexed population.
 *
 * The prefix is selected only after a fresh D1 assertion that all base
 * sales-velocity values are zero. When any nonzero velocity is present,
 * the caller must use the original complete primary-D1 ranking query.
 *
 * No authorization result is cached. The only outputs are an order proof,
 * not access grants or a suggestion to skip rights checks.
 */
export function indexedRecommendationPrefixComplete(
  ranked: ReadonlyArray<{ trend_rank: number; popularity_rank: number }>,
  wanted: number,
  unselectedDownloadBoundary: number | null,
): boolean {
  if (
    !Number.isSafeInteger(wanted) ||
    wanted <= 0 ||
    ranked.length !== wanted ||
    !Number.isFinite(unselectedDownloadBoundary)
  )
    return false;
  const final = ranked[ranked.length - 1];
  const trend = Number(final.trend_rank);
  const popularity = Number(final.popularity_rank);
  if (!Number.isFinite(trend) || !Number.isFinite(popularity)) return false;
  // A strictly better ranking pair cannot be displaced by an unseen
  // zero-velocity ordinary document (whose downloads are <= the boundary).
  // Equality requires complete fallback to preserve updated_at/id tie-breaks.
  return trend > 0 || (trend === 0 && popularity > Math.max(0, unselectedDownloadBoundary!));
}
