/** Bounded presentation-only recovery; never poll entitlement or book rights. */
export function taxonomyCountPollInterval(state: {
  data?: { countsPending?: boolean };
  dataUpdateCount: number;
  errorUpdateCount: number;
}): number | false {
  if (!state.data?.countsPending) return false;
  // React Query increments these for completed fetches, including failures.
  // Stop after six automatic attempts; a visitor can explicitly retry.
  const attempts = state.dataUpdateCount + state.errorUpdateCount;
  return attempts >= 6 ? false : Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 60_000);
}
