/* eslint-disable prettier/prettier -- Feed ordering and bounded transactional capture are security boundaries. */
/**
 * Canonical changefeed sequences are global, strictly increasing primary D1
 * integers. The isolated projection is fully state-derived, so only the last
 * source event within a bounded batch needs rebuilding. Preserve delete as
 * the final source event; never convert it back to an old upsert.
 */
export type CatalogFeedChange = {
  seq: number;
  id: string;
  operation: "upsert" | "delete";
};
export function coalesceCatalogFeedChanges(changes: readonly CatalogFeedChange[]): CatalogFeedChange[] {
  if (changes.length > 16) throw Error("catalog_feed_unbounded_page");
  const latest = new Map<string, CatalogFeedChange>();
  let previous = 0;
  for (const change of changes) {
    if (!Number.isSafeInteger(change.seq) || change.seq <= previous ||
        !/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/.test(change.id) ||
        (change.operation !== "upsert" && change.operation !== "delete"))
      throw Error("catalog_feed_invalid_order_or_event");
    previous = change.seq;
    latest.set(change.id, change);
  }
  return [...latest.values()].sort((a,b) => a.seq - b.seq);
}
