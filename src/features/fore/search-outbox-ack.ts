/**
 * Replace hundreds of independent D1 DELETE statements with one bounded,
 * primary-authoritative conditional acknowledgement. This is ONLY a derived
 * external search index queue, never an entitlement or licensed-read shortcut.
 *
 * Every old change_token must match the currently stored token. A newer event
 * inserted during remote Meilisearch publication MUST survive the stale ack.
 */
export function searchOutboxAcknowledgement(
  rows: { product_id: string; change_token: string }[],
): { sql: string; binds: string[] } {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500)
    throw new Error("Expected 1–500 search outbox acknowledgements");
  const binds: string[] = [];
  for (const row of rows) {
    if (!row || typeof row.product_id !== "string" || !row.product_id ||
        typeof row.change_token !== "string" || !row.change_token)
      throw new Error("A search acknowledgement requires its immutable change token");
    binds.push(row.product_id, row.change_token);
  }
  return {
    sql: `DELETE FROM search_index_outbox
      WHERE (product_id,change_token) IN (VALUES ${rows.map(() => "(?,?)").join(",")})`,
    binds,
  };
}
