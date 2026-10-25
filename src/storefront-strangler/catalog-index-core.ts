/* eslint-disable prettier/prettier -- Bounded isolated SQL fences and adversarial publication proofs are deliberately kept adjacent. */
/**
 * Strictly ADVISORY search metadata in a database physically separate from
 * customer rights and commerce. This function does not make legal decisions.
 * Source status controls whether metadata is even eligible for indexing; the
 * storefront still checks current rights against canonical primary D1.
 */
export type RawCatalogIndexRow = {
  id: string;
  title: string | null;
  summary: string | null;
  authors_json: string | null;
  subjects_json: string | null;
  bookshelves_json: string | null;
  languages_json: string | null;
  rights_status: string | null;
  commercial_use_status: string | null;
  ingest_status: string | null;
  copyright: number | null;
  updated_at: string | null;
};
export type CatalogIndexDocument = {
  productId: string;
  revision: number;
  visible: number;
  title: string;
  authors: string;
  subjects: string;
  shelves: string;
  languages: string;
  description: string;
  updatedAt: string;
};
function cleanText(value: unknown, maximum: number) {
  return String(value ?? "").normalize("NFKC")
    .split("")
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("").replace(/\s+/g, " ").trim().slice(0, maximum);
}
function list(value: unknown, maxItems: number, itemLength: number, objectName = false) {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value || "[]")); } catch { return ""; }
  if (!Array.isArray(parsed)) return "";
  const items = parsed.slice(0, maxItems).map((item) =>
    cleanText(objectName && item && typeof item === "object"
      ? (item as { name?: unknown }).name : item, itemLength),
  ).filter(Boolean);
  return Array.from(new Set(items)).join(" | ");
}
export function normalizeCatalogIndexRow(row: RawCatalogIndexRow | null, id: string, revision: number): CatalogIndexDocument {
  if (!/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/.test(id))
    throw Error("catalog_index_invalid_source_id");
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw Error("catalog_index_invalid_revision");
  if (row && row.id !== id) throw Error("catalog_index_identity_mismatch");
  const visible = Number(Boolean(row && row.copyright === 0 &&
    row.rights_status === "public-domain" && row.commercial_use_status === "approved" &&
    row.ingest_status === "active"));
  return {
    productId: "prd_gutenberg_" + id,
    revision,
    visible,
    title: visible ? cleanText(row?.title, 512) : "",
    authors: visible ? list(row?.authors_json, 40, 200, true) : "",
    subjects: visible ? list(row?.subjects_json, 60, 180) : "",
    shelves: visible ? list(row?.bookshelves_json, 40, 180) : "",
    languages: visible ? list(row?.languages_json, 16, 15) : "",
    description: visible ? cleanText(row?.summary, 5000) : "",
    updatedAt: visible ? cleanText(row?.updated_at, 64) : "",
  };
}
export function catalogIndexWrite(doc: CatalogIndexDocument) {
  return {
    sql: "INSERT INTO catalog_index_documents(product_id,revision,visible,title,authors_text,subjects_text,shelves_text,languages_text,description,source_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(product_id) DO UPDATE SET revision=excluded.revision,visible=excluded.visible,title=excluded.title,authors_text=excluded.authors_text,subjects_text=excluded.subjects_text,shelves_text=excluded.shelves_text,languages_text=excluded.languages_text,description=excluded.description,source_updated_at=excluded.source_updated_at " +
      "WHERE excluded.revision>catalog_index_documents.revision",
    binds: [doc.productId,doc.revision,doc.visible,doc.title,doc.authors,doc.subjects,doc.shelves,doc.languages,doc.description,doc.updatedAt],
  };
}
