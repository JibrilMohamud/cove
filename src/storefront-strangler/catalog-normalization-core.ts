/* eslint-disable prettier/prettier -- Keep independent source revision fences auditable. */
import { normalizeCatalogIndexRow, type RawCatalogIndexRow } from "./catalog-index-core";

// All prepared metadata is ADVISORY. Not a legal grant, country mapping,
// price, entitlement or customer asset. It may be stale at any time.
export type CatalogPreparedMetadata = {
  schema: "cove.catalog.normalized.v1";
  sourceId: string;
  revision: number;
  sourceTitle: string | null;
  sourceSummary: string | null;
  title: string;
  description: string;
  visible: number;
};
export function prepareIsolatedCanonicalMetadata(
  source: RawCatalogIndexRow | null, id: string, revision: number,
): CatalogPreparedMetadata {
  const normalized = normalizeCatalogIndexRow(source,id,revision);
  const rawTitle = source?.title ?? null;
  const rawSummary = source?.summary ?? null;
  // Extremely large or invalid source records must be investigated rather
  // than smuggled through a boundless inter-database publication payload.
  if (String(rawTitle ?? "").length > 8192 ||
      String(rawSummary ?? "").length > 120000) throw Error("catalog_source_too_large");
  return {
    schema: "cove.catalog.normalized.v1",
    sourceId: id,
    revision,
    sourceTitle: rawTitle,
    sourceSummary: rawSummary,
    title: normalized.title,
    description: normalized.description,
    visible: normalized.visible,
  };
}
export function catalogPreparationWrite(doc: CatalogPreparedMetadata) {
  return {
    sql: `INSERT INTO catalog_normalized_preparations
      (source_id,revision,visible,source_title,source_summary,title,description)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,
      visible=excluded.visible,source_title=excluded.source_title,
      source_summary=excluded.source_summary,title=excluded.title,
      description=excluded.description
      WHERE excluded.revision>catalog_normalized_preparations.revision`,
    binds: [doc.sourceId,doc.revision,doc.visible,doc.sourceTitle,doc.sourceSummary,doc.title,doc.description],
  };
}
