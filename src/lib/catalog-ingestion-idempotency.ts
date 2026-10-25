/**
 * Skip expensive Gutendex normalization only when the previously completed
 * canonical product projection is byte-for-byte consistent with current
 * publisher data and the approved source-rights evidence.
 *
 * Never inspect this as a retailer entitlement or delivery authorization.
 * Changes, incomplete prior publication, withdrawn/quarantined rights and
 * missing canonical rows ALWAYS go through the full normalization path.
 */
export type ExistingGutendexProjection = Record<string, unknown>;

export function unchangedNormalizedGutendexBook(
  book: {
    id: string | number;
    title: string;
    authors?: unknown[];
    summaries?: string[];
    subjects?: unknown[];
    bookshelves?: unknown[];
    languages?: unknown[];
    formats?: Record<string, unknown>;
    download_count?: number;
    copyright?: boolean | null;
  },
  row: ExistingGutendexProjection | undefined,
  sourceUrl: string,
): boolean {
  if (!row || book.copyright !== false) return false;
  const id = String(book.id);
  if (row.id !== id || row.source_id !== "pg_us" ||
      row.source_item_id !== id || row.ingest_status !== "active" ||
      row.rights_status !== "public-domain" ||
      row.commercial_use_status !== "approved" ||
      row.rights_territories_json !== '["US"]' ||
      row.rights_evidence_url !== sourceUrl ||
      row.source_url !== sourceUrl) return false;
  if (!row.product_id || String(row.product_id) !== "prd_gutenberg_" + id)
    return false;
  if (!row.updated_at || row.updated_at !== row.projection_updated_at)
    return false;
  return (
    row.title === book.title &&
    row.projection_title === book.title &&
    row.authors_json === JSON.stringify(book.authors || []) &&
    row.summary === (book.summaries?.[0] || "") &&
    row.subjects_json === JSON.stringify(book.subjects || []) &&
    row.bookshelves_json === JSON.stringify(book.bookshelves || []) &&
    row.languages_json === JSON.stringify(book.languages || []) &&
    row.formats_json === JSON.stringify(book.formats || {}) &&
    Number(row.download_count) === (Number(book.download_count) || 0) &&
    Number(row.projection_download_count) === (Number(book.download_count) || 0) &&
    Number(row.copyright) === 0
  );
}
