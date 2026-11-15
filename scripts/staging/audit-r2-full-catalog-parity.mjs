import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// This is a BLOCKING inventory, not a synthetic performance pass. Whenever a
// CatalogBook field is added, its storage/authority classification must be
// explicitly reviewed. A green audit here NEVER certifies parity by itself.
const CANONICAL = "src/features/fore/client.ts";
const STAGE = "src/features/fore/synthetic-r2-live-rights-page.stage.ts";

const FRESH_PRIMARY = [
  "id",
  "productId",
  "editionId",
  "workId",
  "publicProductId",
  "publicEditionId",
  "publicWorkId",
  "formats",
  "download_count",
  "copyright",
  "uploaded",
  "drmStatus",
  "downloadable",
  "readingAvailability",
  "releaseStatus",
  "subscriptionEligible",
  "libraryEligible",
  "offer",
];

const R2_PUBLIC_DISPLAY = [
  "title",
  "subtitle",
  "authors",
  "contributors",
  "summaries",
  "subjects",
  "bookshelves",
  "languages",
  "publisher",
  "publisherId",
  "publisherSlug",
  "imprint",
  "imprintId",
  "imprintSlug",
  "isbn13",
  "publicationDate",
  "originalPublicationDate",
  "releaseDate",
  "preorderDate",
  "editionNumber",
  "originalLanguage",
  "ageRange",
  "contentWarnings",
  "pageEstimate",
  "wordCount",
  "readingTimeMinutes",
  "publisherDescription",
  "editorialReviews",
  "series",
];

// Must be reviewed for disclosure/license semantics or asset refresh before
// anyone proposes to put these richer source/details into a public R2 cache.
const NEEDS_POLICY_REVIEW = [
  "sourceExternalId",
  "sourceName",
  "sourceProject",
  "sourceUrl",
  "sourceLicenseUrl",
  "externalIdentifiers",
  "fileSizeBytes",
  "epubVersion",
  "layout",
  "accessibility",
  "formatProfile",
  "aiDisclosure",
];

const source = readFileSync(CANONICAL, "utf8");
const stage = readFileSync(STAGE, "utf8");
const start = source.indexOf("export type CatalogBook = {");
const end = source.indexOf("export type LibraryBook = {", start);
assert.ok(start !== -1 && end > start, "Canonical catalog contract could not be read");
const canonicalFields = [...source.slice(start, end).matchAll(/^  ([a-zA-Z_]\w*)\??:/gm)].map(
  (match) => match[1],
);
const covered = [...FRESH_PRIMARY, ...R2_PUBLIC_DISPLAY, ...NEEDS_POLICY_REVIEW];
assert.equal(new Set(canonicalFields).size, canonicalFields.length);
assert.equal(new Set(covered).size, covered.length, "Every canonical field needs ONE owner");
assert.deepEqual(
  [...covered].sort(),
  [...canonicalFields].sort(),
  "New, retired or unclassified CatalogBook field: review before enabling any R2 catalog",
);
const stageBody = stage.match(/books\.push\(\{([\s\S]*?)\n    \}\);/);
assert.ok(stageBody, "Synthetic response composer changed; re-review its contract");
const stageFields = [...stageBody[1].matchAll(/^      ([a-zA-Z_]\w*)(?:\s*[:,])/gm)].map(
  (match) => match[1],
);
assert.equal(new Set(stageFields).size, stageFields.length);
assert.ok(stageFields.every((field) => canonicalFields.includes(field)));
const snapshotKeys = stage.match(/const ALLOWED_KEYS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(snapshotKeys, "Public snapshot allowlist cannot be inferred");
const r2Keys = [...snapshotKeys[1].matchAll(/"([a-zA-Z_]\w*)"/g)].map((match) => match[1]);
for (const forbidden of FRESH_PRIMARY.filter(
  (field) => !["productId", "editionId"].includes(field),
)) {
  assert.equal(r2Keys.includes(forbidden), false, "Authorizing field cached in R2: " + forbidden);
}
assert.doesNotMatch(stage, /releaseCertified:\s*true/);
const missing = canonicalFields.filter((field) => !stageFields.includes(field));
const audit = {
  schema: "cove.synthetic-r2-full-catalog-parity-inventory.v1",
  releaseCertified: false,
  canonicalFieldCount: canonicalFields.length,
  stageReturnedFieldCount: stageFields.length,
  stageMissingFieldCount: missing.length,
  stageMissingFields: missing,
  missingFreshPrimaryFields: FRESH_PRIMARY.filter((field) => missing.includes(field)),
  missingPublicDisplayFields: R2_PUBLIC_DISPLAY.filter((field) => missing.includes(field)),
  unreviewedR2PolicyFields: NEEDS_POLICY_REVIEW,
  r2SnapshotAllowlistedKeys: r2Keys,
  note:
    "All 59 canonical DTO fields are assigned a prospective owner, but many are not implemented, " +
    "measured or legally certified. Production full-catalog parity is BLOCKED.",
};
assert.ok(missing.length > 0, "Audit certificate must be redesigned before claiming parity");
console.log(JSON.stringify(audit));
