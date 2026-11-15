import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// This is a BLOCKING inventory, not a synthetic performance pass. Whenever a
// CatalogBook field is added, its storage/authority classification must be
// explicitly reviewed. A green audit here NEVER certifies parity by itself.
const CANONICAL = "src/features/fore/client.ts";
const API = "src/features/fore/api.server.ts";
const ENVELOPE = "src/features/fore/catalog-envelope.server.ts";
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
  "sourceExternalId",
  "sourceName",
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
  "externalIdentifiers",
  "fileSizeBytes",
  "epubVersion",
  "layout",
  "accessibility",
  "formatProfile",
  "sourceProject",
  "sourceUrl",
  "sourceLicenseUrl",
  "aiDisclosure",
  "series",
];

// EXPERIMENTAL: all canonical PUBLIC book metadata, including source-license
// attribution and public AI disclosure, is bounded stage-only R2 display with
// 120-second TTL. This is NOT approved for production: attribution/disclosure
// freshness and legally acceptable revocation/version semantics still need
// independent review. Rights, offers, DRM, protected assets and entitlements
// are always fresh primary-D1 and must never be cached in R2.
const NEEDS_POLICY_REVIEW = [];

const source = readFileSync(CANONICAL, "utf8");
const api = readFileSync(API, "utf8");
const sharedEnvelope = readFileSync(ENVELOPE, "utf8");
const stage = readFileSync(STAGE, "utf8");
const metadataSql = readFileSync(
  "scripts/staging/sql/synthetic-public-metadata-revision-fence.sql",
  "utf8",
);
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
assert.match(stage, /metadata_revision AS MATERIALIZED/);
assert.match(stage, /cove_synthetic_public_metadata_revision/);
assert.match(stage, /public_metadata_revision !== snapshot\.publicMetadataRevision/);
assert.match(stage, /after\?\.public_metadata_revision !== before\.public_metadata_revision/);
assert.equal(
  [...metadataSql.matchAll(/CREATE TRIGGER IF NOT EXISTS/g)].length,
  15,
  "All metadata mutation writers, including source INSERT, require an independently verified generation trigger",
);
assert.doesNotMatch(metadataSql, /4bd657ac-8789-403e-a28c-93aba8d0a989/);

const missing = canonicalFields.filter((field) => !stageFields.includes(field));
const catalogStart = api.indexOf("async function catalog(");
const catalogEnd = api.indexOf("function libraryRow(", catalogStart);
assert.ok(catalogStart !== -1 && catalogEnd > catalogStart);
const canonicalEnvelope = api.slice(catalogStart, catalogEnd);
// Keep the existing production handler byte-for-byte intact until the
// canonical-writer source-bound attestation is independently reconciled.
const productionBlock = canonicalEnvelope.match(
  /return \{\s*results:\s*result\.books,([\s\S]*?)\n    \};/,
);
assert.ok(productionBlock, "Original production catalog payload structure changed");
const envelopeFields = [
  "results",
  ...[...productionBlock[1].matchAll(/^      ([a-zA-Z_]\w*)(?:\s*[:,])/gm)].map(
    (match) => match[1],
  ),
];
const sharedBlock = sharedEnvelope.match(/return \{\s*results:\s*result\.books,([\s\S]*?)\n  \};/);
assert.ok(sharedBlock, "Shared canonical catalog payload structure changed");
const sharedFields = [
  "results",
  ...[...sharedBlock[1].matchAll(/^    ([a-zA-Z_]\w*)(?:\s*[:,])/gm)].map((match) => match[1]),
];
assert.deepEqual(
  sharedFields,
  envelopeFields,
  "Shared contract must preserve exact current production envelope field order",
);
const probeStart = stage.indexOf("const result = await syntheticR2PageWithLiveRights");
const probeReturn = stage
  .slice(probeStart)
  .match(/return Response\.json\(\s*\{([\s\S]*?)\n      \},/);
assert.ok(probeReturn, "Synthetic endpoint contract could not be read");
const stagedEnvelopeFields = [...probeReturn[1].matchAll(/^        ([a-zA-Z_]\w*)\s*:/gm)].map(
  (match) => match[1],
);
assert.deepEqual(
  [...envelopeFields].sort(),
  [
    "results",
    "count",
    "next",
    "cached",
    "facets",
    "facetsPending",
    "countPending",
    "search",
    "ingestion",
  ].sort(),
  "Canonical catalog envelope changed; review pagination and facet parity",
);
const missingEnvelope = envelopeFields.filter((field) => !stagedEnvelopeFields.includes(field));
const audit = {
  schema: "cove.synthetic-r2-full-catalog-parity-inventory.v2",
  canonicalEnvelopeFields: envelopeFields,
  stageEnvelopeFields: stagedEnvelopeFields,
  missingEnvelopeFields: missingEnvelope,
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
    "The synthetic R2 public metadata now has a live generation check in the same " +
    "D1 statement as current rights. Production deployment, writer trigger inventory " +
    "and fail-closed reseeding are NOT certified. Actual count/next/facets/search/" +
    "ingestion, customer SSR/503, geographic performance, legal/payment and rollback " +
    "certification remain BLOCKED.",
};
assert.ok(
  missing.length > 0 || missingEnvelope.length > 0,
  "Audit certificate must be redesigned before claiming parity",
);
console.log(JSON.stringify(audit));
