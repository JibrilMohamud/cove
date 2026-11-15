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
const catalogStart = api.indexOf("async function catalog(");
const catalogEnd = api.indexOf("function libraryRow(", catalogStart);
assert.ok(catalogStart !== -1 && catalogEnd > catalogStart);
const canonicalEnvelope = api.slice(catalogStart, catalogEnd);
assert.match(
  canonicalEnvelope,
  /return canonicalCatalogEnvelope\(url, input\.page, result, ingestion\)/,
  "Production handler must reuse tested canonical search envelope",
);
assert.match(
  api,
  /import \{ canonicalCatalogEnvelope \} from "\.\/catalog-envelope\.server";/,
  "Production handler import missing shared envelope",
);
const envelopeBlock = sharedEnvelope.match(
  /return \{\s*results:\s*result\.books,([\s\S]*?)\n  \};/,
);
assert.ok(envelopeBlock, "Shared canonical catalog payload structure changed");
const envelopeFields = [
  "results",
  ...[...envelopeBlock[1].matchAll(/^    ([a-zA-Z_]\w*)(?:\s*[:,])/gm)].map(
    (match) => match[1],
  ),
];
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
    "Catalog envelope parity remains incomplete even if all 59 book DTO field names " +
    "are present. Fresh primary projection is not proof of semantic/access/rights " +
    "equivalence. count/next/facets/search/ingestion, customer SSR/503, geographic " +
    "performance and production legal/payment/rollback certification are BLOCKED.",
};
assert.ok(
  missing.length > 0 || missingEnvelope.length > 0,
  "Audit certificate must be redesigned before claiming parity",
);
console.log(JSON.stringify(audit));
