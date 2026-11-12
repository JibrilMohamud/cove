/**
 * A replica-eligible search query may discover and rank anonymous PUBLIC
 * candidate IDs, but it cannot decide whether an edition can be shown.
 * Every nonempty page requires a current primary-D1 rights/filter recheck.
 *
 * This is opt-in presentation only. A stale/empty/malformed replica result
 * falls back to the ordinary fully authoritative primary ranking query.
 * If primary validation is unavailable, the error propagates (fail closed).
 * No replica result is ever used for checkout, entitlements, DRM or reading.
 */
export type RankedCandidate = { product_id: string };
export type RankedCandidatePage<T extends RankedCandidate> = { results: T[] };

export async function rightsRecheckedReplicaCandidates<T extends RankedCandidate>(options: {
  enabled: boolean;
  maxPageSize: number;
  selectPrimary: () => Promise<RankedCandidatePage<T>>;
  selectReplica: () => Promise<RankedCandidatePage<T>>;
  recheckPrimary: (ids: string[]) => Promise<string[]>;
}): Promise<RankedCandidatePage<T>> {
  if (!options.enabled) return options.selectPrimary();

  let proposal: RankedCandidatePage<T>;
  try {
    proposal = await options.selectReplica();
  } catch {
    // No cross-request cache and no unsafe fallback to replica results.
    return options.selectPrimary();
  }
  const rows = proposal?.results;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > options.maxPageSize)
    return options.selectPrimary();
  const ids = rows.map((row) => row?.product_id);
  if (ids.some((id) => typeof id !== "string" || !id || id.length > 128))
    return options.selectPrimary();
  if (new Set(ids).size !== ids.length) return options.selectPrimary();

  // This must use env.DB, not a replica session or a cached legal decision.
  // Throw on primary error so a failed revocation check can NEVER show a book.
  const verified = await options.recheckPrimary(ids);
  if (
    !Array.isArray(verified) ||
    verified.length !== ids.length ||
    verified.some((id) => typeof id !== "string") ||
    new Set(verified).size !== ids.length ||
    !ids.every((id) => verified.includes(id))
  )
    return options.selectPrimary();

  return proposal;
}
