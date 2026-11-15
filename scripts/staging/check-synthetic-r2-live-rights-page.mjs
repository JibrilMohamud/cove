import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-stage-r2-live-fence-"));
try {
  await build({
    entryPoints: ["src/features/fore/synthetic-r2-live-rights-page.stage.ts"],
    outfile: path.join(dir, "presentation.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    alias: { jszip: "jszip/dist/jszip.min.js" },
    logLevel: "silent",
  });
  const {
    buildSyntheticDisplayObject,
    eligibleSyntheticR2Page,
    seedSyntheticR2Display,
    handleSyntheticR2LiveRightsStage,
    syntheticR2PageWithLiveRights,
  } = await import(path.join(dir, "presentation.mjs"));
  const books = Array.from({ length: 96 }, (_, i) => ({
    id: "public-" + i,
    productId: "perf-synth-" + i,
    editionId: "edition-synth-" + i,
    title: "Stage book " + i,
    subtitle: "Only public description",
    authors: [{ id: "author-" + i, slug: "synthetic-author", name: "Synthetic author" }],
    contributors: [
      {
        id: "author-" + i,
        slug: "synthetic-author",
        name: "Synthetic author",
        role: "author",
        position: 0,
      },
    ],
    summaries: ["Public canonical summary"],
    publisher: "Synthetic Press",
    publisherId: "pub-" + i,
    publisherSlug: "synthetic-press",
    imprint: "Synthetic Books",
    imprintId: "imp-" + i,
    imprintSlug: "synthetic-books",
    isbn13: "9780000000000",
    publicationDate: "2026-01-15",
    originalPublicationDate: "2024-02-01",
    releaseDate: "2026-01-15",
    editionNumber: "1",
    originalLanguage: "en",
    ageRange: { min: 12, max: 18 },
    contentWarnings: ["Nonviolent synthetic sample"],
    pageEstimate: 244,
    wordCount: 54321,
    readingTimeMinutes: 300,
    externalIdentifiers: {
      product: { gutenberg: "1" },
      edition: { edition: "edition-v2" },
      work: { work: "work-v3" },
    },
    fileSizeBytes: 12345,
    epubVersion: "3.0",
    layout: "reflowable",
    accessibility: { screenReaderCompatible: 1, accessModes: ["textual"] },
    formatProfile: { epubVersion: "3", compatibilityClass: "reflowable" },
    sourceProject: "gutenberg",
    sourceUrl: "https://www.gutenberg.org/ebooks/1",
    sourceLicenseUrl: "https://www.gutenberg.org/policy/license.html",
    aiDisclosure: {
      policyVersion: "2026.1",
      textOrigin: "human",
      publicBadges: [{ key: "human", label: "Human written" }],
    },
    publisherDescription: "Sample descriptive publisher text",
    editorialReviews: "Sample editorial review",
    series: [
      { id: "series-" + i, slug: "synthetic-series", name: "Synthetic Series", position: 1 },
    ],
    subjects: ["fiction"],
    bookshelves: [],
    languages: ["en"],
    formats: {
      "image/jpeg": "https://cdn.example.test/cover-" + i + ".jpg",
      "application/epub+zip": "/api/fore/books/protected-" + i + "/epub",
    },
    download_count: 1000,
    offer: { type: "retail", currency: "USD", amountMinor: 1 },
    drmStatus: "restricted",
    subscriptionEligible: true,
    libraryEligible: true,
    downloadable: true,
    readingAvailability: { state: "stored" },
  }));
  const now = 2_000_000_000_000;
  const snapshot = buildSyntheticDisplayObject(books, now, "1");
  for (const field of [
    "application/epub+zip",
    "protected-",
    "subscriptionEligible",
    "libraryEligible",
    "drmStatus",
    "downloadable",
    "readingAvailability",
    "amountMinor",
    "offer",
  ]) {
    assert.equal(snapshot.includes(field), false, "R2 must exclude " + field);
  }

  assert.throws(() => buildSyntheticDisplayObject(books, now, "0"), /revision/);
  assert.throws(() => buildSyntheticDisplayObject(books, now, "1e1"), /revision/);
  const cleanSnapshot = JSON.parse(snapshot);
  assert.equal(cleanSnapshot.publicMetadataRevision, "1");
  assert.equal(cleanSnapshot.items[0].authors[0].id, "author-0");
  assert.equal(cleanSnapshot.items[0].contributors[0].role, "author");
  assert.equal(cleanSnapshot.items[0].publisher, "Synthetic Press");
  assert.equal(cleanSnapshot.items[0].summaries[0], "Public canonical summary");
  assert.equal(cleanSnapshot.items[0].series[0].name, "Synthetic Series");
  assert.equal(cleanSnapshot.items[0].pageEstimate, 244);
  assert.equal(cleanSnapshot.items[0].externalIdentifiers.product.gutenberg, "1");
  assert.equal(cleanSnapshot.items[0].fileSizeBytes, 12345);
  assert.equal(cleanSnapshot.items[0].epubVersion, "3.0");
  assert.equal(cleanSnapshot.items[0].accessibility.screenReaderCompatible, 1);
  assert.equal(cleanSnapshot.items[0].formatProfile.compatibilityClass, "reflowable");
  assert.equal(
    cleanSnapshot.items[0].sourceLicenseUrl,
    "https://www.gutenberg.org/policy/license.html",
  );
  assert.equal(cleanSnapshot.items[0].aiDisclosure.policyVersion, "2026.1");
  assert.equal(cleanSnapshot.items[0].publisherDescription, "Sample descriptive publisher text");

  const GATE = "a".repeat(64);
  let dbCalls = 0;
  let returned = [];
  let primaryError = null;
  let failFallbackD1 = false;
  const env = {
    COVE_SYNTHETIC_STAGING_ONLY: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    FORE_GUEST_COMPACT_STAGE: "1",
    FORE_GUEST_R2_DISPLAY_STAGE: "1",
    FORE_GUEST_COMPACT_SYNTHETIC_D1_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    FORE_BACKEND_TOKEN: GATE,
    COVE_PUBLIC_PRESENTATION_CACHE: {
      get: async () => ({ etag: "test", size: snapshot.length, text: async () => snapshot }),
    },
    DB: {
      prepare(sql) {
        dbCalls++;
        assert.match(sql, /storefront_markets/);
        assert.match(sql, /metadata_revision AS MATERIALIZED/);
        assert.match(sql, /cove_synthetic_public_metadata_revision/);
        assert.match(sql, /public_metadata_revision/);
        assert.match(sql, /retail_product_availability_rows/);
        assert.match(sql, /JOIN works w ON w.id=e.work_id/);
        assert.match(sql, /a.subscription_eligible/);
        assert.match(sql, /a.downloadable/);
        assert.match(sql, /has_epub_object/);
        assert.match(sql, /has_epub_source/);
        assert.match(sql, /gutenberg_source_cache/);
        assert.doesNotMatch(sql, /product_external_ids_json/);
        assert.doesNotMatch(sql, /accessibility_json/);
        assert.doesNotMatch(sql, /format_profile_json/);
        assert.doesNotMatch(sql, /ai_disclosure_json/);
        assert.doesNotMatch(sql, /source_license_url/);
        assert.match(sql, /FROM offers o/);
        assert.match(sql, /EXISTS \(SELECT 1 FROM offers offer_exists/);
        assert.doesNotMatch(sql, /\\b(?:INSERT|UPDATE|DELETE|REPLACE)\\b/i);
        return {
          bind(...params) {
            assert.ok(
              sql.includes("ORDER BY c.position LIMIT 25") ||
                sql.includes("ORDER BY c.position LIMIT 49"),
              "Only bounded, static D1 witness limits are permitted",
            );
            assert.equal(params[0], "US");
            const candidates = JSON.parse(params[1]);
            assert.ok(
              candidates.length >= 25 && candidates.length <= 96,
              "Only bounded 25-96 candidate live authorization reads are permitted",
            );
            assert.deepEqual(params.slice(2), ["USD", "USD", "US"]);
            const inWindow = new Set(candidates);
            return {
              async all() {
                if (primaryError) throw primaryError;
                if (failFallbackD1 && candidates.length > 56)
                  throw Object.assign(new Error("D1 overload during fallback"), { code: 7429 });
                const eligible = returned.filter((row) => inWindow.has(row.product_id));
                return {
                  results: sql.includes("page_rows AS MATERIALIZED")
                    ? eligible.slice(24, 48).map((row) => ({
                        ...row,
                        live_witness_count: Math.min(eligible.length, 49),
                      }))
                    : eligible.slice(0, 25),
                };
              },
            };
          },
        };
      },
    },
  };
  const rows = (ids, price = 599) =>
    ids.map((i) => ({
      product_id: "perf-synth-" + i,
      edition_id: "edition-synth-" + i,
      product_public_id: "public-" + i,
      edition_public_id: "pub-ed-" + i,
      work_id: "work-synth-" + i,
      work_public_id: "wrk_" + i,
      source_name: "gutenberg",
      source_external_id: "gutenberg-synth-" + i,
      release_status: "available",
      drm_status: "none",
      downloadable: 1,
      subscription_eligible: 0,
      library_eligible: 0,
      download_count: 17,
      epub_storage_status: null,
      has_epub_object: 0,
      has_epub_source: 0,
      public_metadata_revision: "1",
      offer_json: JSON.stringify({ type: "retail", currency: "USD", amountMinor: price }),
    }));
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  const req = (headers = {}, address = undefined) =>
    new Request(
      address ||
        "https://cove-presentation-r2-proof-20261114.cove-jibrilmohamud.workers.dev/api/fore/__perf/private-r2-live-rights",
      {
        headers: {
          "x-cove-backend-token": GATE,
          "x-cove-client-country": "US",
          ...headers,
        },
      },
    );
  const request = req();
  assert.equal(eligibleSyntheticR2Page(request, env), true);
  let prepared = "";
  let changeDuringSeed = false;
  let generationSeedReads = 0;
  const stageSeedEnv = {
    ...env,
    DB: {
      prepare(sql) {
        if (sql.includes("cove_synthetic_public_metadata_revision")) {
          assert.match(sql, /CAST\(revision AS TEXT\)/);
          return {
            first: async () => ({
              public_metadata_revision: changeDuringSeed && ++generationSeedReads === 2 ? "2" : "1",
            }),
          };
        }
        if (sql.includes("idx_search_popular_stable")) {
          return {
            all: async () => ({
              results: books.map((b) => ({
                product_id: b.productId,
                edition_id: b.editionId.replace("edition-synth-", "perf-synth-"),
              })),
            }),
          };
        }
        assert.match(sql, /FROM products p JOIN editions e ON e.id=p.edition_id/);
        assert.match(sql, /contributors_json/);
        return {
          bind(...ids) {
            assert.deepEqual(
              ids,
              books.map((b) => b.productId),
            );
            return {
              all: async () => ({
                results: books.map((b, i) => ({
                  product_id: b.productId,
                  product_public_id: String(b.id),
                  edition_id: "perf-synth-" + i,
                  edition_public_id: "ed-public-" + i,
                  work_id: "work-" + i,
                  work_public_id: "work-public-" + i,
                  source_name: "gutenberg",
                  source_external_id: "gutenberg-" + i,
                  title: b.title,
                  subtitle: b.subtitle,
                  description: "Canonical source description " + i,
                  file_size_bytes: 12345,
                  epub_version: "3.0",
                  layout: "reflowable",
                  product_external_ids_json: JSON.stringify({ gutenberg: "1" }),
                  edition_external_ids_json: JSON.stringify({ edition: "edition-v2" }),
                  work_external_ids_json: JSON.stringify({ work: "work-v3" }),
                  accessibility_json: JSON.stringify({ screenReaderCompatible: 1 }),
                  format_profile_json: JSON.stringify({ epubVersion: "3" }),
                  source_project: "gutenberg",
                  source_page_url: "https://www.gutenberg.org/ebooks/1",
                  source_license_url: "https://www.gutenberg.org/policy/license.html",
                  ai_disclosure_json: JSON.stringify({
                    policyVersion: "2026.1",
                    textOrigin: "human",
                    publicBadges: [{ key: "human", label: "Human written" }],
                  }),
                  contributors_json: JSON.stringify([
                    {
                      id: "source-author-" + i,
                      slug: "real-author",
                      name: "Verified Source Author",
                      role: "author",
                      position: 0,
                    },
                  ]),
                  subjects_json: JSON.stringify(["actual subject"]),
                  bookshelves_json: JSON.stringify(["actual bookshelf"]),
                  languages_json: JSON.stringify(["en"]),
                  publisher_name: "Actual Publisher",
                  publisher_id: "actual-pub-" + i,
                  publisher_slug: "actual-publisher",
                  imprint_name: "Actual Imprint",
                  imprint_id: "actual-imp-" + i,
                  imprint_slug: "actual-imprint",
                  isbn13: "9780000000000",
                  original_publication_date: "2024-02-01",
                  publication_date: "2026-01-15",
                  release_date: "2026-01-15",
                  page_estimate: 244,
                  word_count: 54321,
                  reading_time_minutes: 300,
                  publisher_description: "Verified source public description",
                  editorial_reviews: "Verified source editorial notes",
                  series_json: JSON.stringify([
                    { id: "serie-" + i, name: "Source Series", position: 1 },
                  ]),
                  min_age: 12,
                  max_age: 18,
                  content_warnings: "Nonviolent synthetic sample",
                  epub_object_key: "synthetic/private/epub-key",
                  drm_status: "restricted",
                  subscription_eligible: 1,
                  downloadable: 1,
                  offer_json: JSON.stringify({ type: "retail", currency: "USD", amountMinor: 99 }),
                })),
              }),
            };
          },
        };
      },
    },
    COVE_PUBLIC_PRESENTATION_CACHE: {
      get: async () => (prepared ? { etag: "saved", text: async () => prepared } : null),
      put: async (key, body, conditions) => {
        assert.match(key, /synthetic-ranked-books-v1/);
        assert.deepEqual(conditions, { onlyIf: { etagDoesNotMatch: "*" } });
        prepared = body;
        return { etag: "saved" };
      },
    },
  };
  // A mutation between the before/after generation reads invalidates the
  // in-progress seed, rather than publishing a mixed license/AI snapshot.
  changeDuringSeed = true;
  assert.equal(await seedSyntheticR2Display(stageSeedEnv, () => now), false);
  assert.equal(prepared, "");
  changeDuringSeed = false;
  generationSeedReads = 0;
  assert.equal(await seedSyntheticR2Display(stageSeedEnv, () => now), true);
  assert.equal(JSON.parse(prepared).items.length, 96);
  assert.equal(JSON.parse(prepared).publicMetadataRevision, "1");
  assert.equal(prepared.includes("amountMinor"), false);
  assert.equal(prepared.includes("synthetic/private/epub-key"), false);
  const seeded = JSON.parse(prepared).items[0];
  assert.deepEqual(seeded.authors, [
    { id: "source-author-0", slug: "real-author", name: "Verified Source Author" },
  ]);
  assert.equal(seeded.contributors[0].name, "Verified Source Author");
  assert.deepEqual(seeded.subjects, ["actual subject"]);
  assert.deepEqual(seeded.bookshelves, ["actual bookshelf"]);
  assert.deepEqual(seeded.summaries, ["Canonical source description 0"]);
  assert.equal(seeded.publisher, "Actual Publisher");
  assert.equal(seeded.publisherDescription, "Verified source public description");
  assert.equal(seeded.series[0].name, "Source Series");
  assert.deepEqual(seeded.externalIdentifiers.product, { gutenberg: "1" });
  assert.equal(seeded.accessibility.screenReaderCompatible, 1);
  assert.equal(seeded.formatProfile.epubVersion, "3");
  assert.equal(seeded.fileSizeBytes, 12345);
  assert.equal(seeded.layout, "reflowable");
  assert.equal(seeded.sourceProject, "gutenberg");
  assert.equal(seeded.sourceLicenseUrl, "https://www.gutenberg.org/policy/license.html");
  assert.equal(seeded.aiDisclosure.policyVersion, "2026.1");
  const seedReq = new Request(request.url + "/seed", {
    method: "POST",
    headers: request.headers,
  });
  const deniedSeed = await handleSyntheticR2LiveRightsStage(seedReq, {
    ...stageSeedEnv,
    FORE_GUEST_R2_DISPLAY_STAGE: "0",
  });
  assert.equal(deniedSeed.status, 404);
  const badBodySeed = await handleSyntheticR2LiveRightsStage(
    new Request(seedReq.url, { method: "POST", headers: request.headers, body: "unsafe" }),
    stageSeedEnv,
  );
  assert.equal(badBodySeed.status, 404);
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  const liveRouteSnapshot = buildSyntheticDisplayObject(books, Date.now(), "1");
  const liveRouteEnv = {
    ...env,
    COVE_PUBLIC_PRESENTATION_CACHE: {
      get: async () => ({ etag: "saved", text: async () => liveRouteSnapshot }),
    },
  };
  const stageLive = await handleSyntheticR2LiveRightsStage(request, liveRouteEnv);
  assert.equal(stageLive.status, 200);
  assert.equal(stageLive.headers.get("x-cove-persistence"), "d1-live-retail-r2-display-synthetic");
  const stageBody = await stageLive.json();
  assert.equal(stageBody.results.length, 24);
  assert.equal(stageBody.releaseCertified, false);
  assert.equal(stageBody.mode, "r2-live-retail");

  // A signed continuation resumes AFTER the last displayed rank, rather
  // than rescanning 49 live authorization candidates from the start.
  assert.match(stageBody.nextCursor, /^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/);
  const cursorRequest = req({}, request.url + "?cursor=" + stageBody.nextCursor);
  assert.equal(eligibleSyntheticR2Page(cursorRequest, env), true);
  returned = rows(Array.from({ length: 25 }, (_, i) => i + 24));
  const cursorStartCalls = dbCalls;
  const continued = await syntheticR2PageWithLiveRights(cursorRequest, liveRouteEnv);
  assert.equal(dbCalls - cursorStartCalls, 1, "Cursor page needs one 32-ID live D1 read");
  assert.equal(continued?.books.length, 24);
  assert.equal(continued.books[0].productId, "perf-synth-24");
  assert.equal(continued.books[23].productId, "perf-synth-47");
  const liveCursorResponse = await handleSyntheticR2LiveRightsStage(cursorRequest, liveRouteEnv);
  assert.equal(liveCursorResponse.status, 200);
  const liveCursorBody = await liveCursorResponse.json();
  assert.equal(liveCursorBody.results[0].productId, "perf-synth-24");
  assert.match(liveCursorBody.nextCursor, /^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/);
  assert.equal(Object.hasOwn(liveCursorBody, "count"), false);
  assert.equal(Object.hasOwn(liveCursorBody, "facets"), false);

  // A withdrawal BEFORE the signed anchor may shift offset page 2, but must
  // not repeat a previously seen book in cursor page 2.
  returned = rows(Array.from({ length: 25 }, (_, i) => i + 25));
  const shiftedCursor = await syntheticR2PageWithLiveRights(cursorRequest, liveRouteEnv);
  assert.equal(shiftedCursor?.books[0].productId, "perf-synth-25");
  assert.equal(shiftedCursor.books[23].productId, "perf-synth-48");

  // Withdraw eight from the 32-ID cursor prefix; a fresh remainder-only
  // query must replace it, never stitching older positive rights witnesses.
  returned = rows(Array.from({ length: 25 }, (_, i) => i + 32));
  const cursorFallbackStart = dbCalls;
  const fallbackCursor = await syntheticR2PageWithLiveRights(cursorRequest, liveRouteEnv);
  assert.equal(dbCalls - cursorFallbackStart, 2);
  assert.equal(fallbackCursor?.books[0].productId, "perf-synth-32");
  assert.equal(fallbackCursor.books[23].productId, "perf-synth-55");
  failFallbackD1 = true;
  await assert.rejects(
    () => syntheticR2PageWithLiveRights(cursorRequest, liveRouteEnv),
    /fallback/,
    "Failed fresh cursor fallback must never reuse prior primary results",
  );
  failFallbackD1 = false;

  // Forgery and immutable-snapshot reseed are rejected BEFORE any D1 read.
  const forgedCursor =
    stageBody.nextCursor.slice(0, -1) +
    (stageBody.nextCursor.endsWith("A") ? "B" : "A");
  const forgedRequest = req({}, request.url + "?cursor=" + forgedCursor);
  const beforeForged = dbCalls;
  assert.equal(await syntheticR2PageWithLiveRights(forgedRequest, liveRouteEnv), null);
  const forgedResponse = await handleSyntheticR2LiveRightsStage(forgedRequest, liveRouteEnv);
  assert.equal(forgedResponse.status, 503);
  assert.equal(dbCalls, beforeForged, "A forged token cannot authorize a D1 query");
  const reseeded = JSON.parse(liveRouteSnapshot);
  reseeded.items[0].title = "Revised stage-only public display";
  const changedEnv = {
    ...liveRouteEnv,
    COVE_PUBLIC_PRESENTATION_CACHE: {
      get: async () => ({ text: async () => JSON.stringify(reseeded) }),
    },
  };
  assert.equal(await syntheticR2PageWithLiveRights(cursorRequest, changedEnv), null);
  assert.equal(dbCalls, beforeForged, "Replayed cursor must be bound to immutable R2 bytes");
  returned = rows(Array.from({ length: 25 }, (_, i) => i));

  // Real staged page-two selection requires 49 current D1 witnesses:
  // the first 24 are skipped only AFTER current rights filtering, and the
  // 49th proves a third page. This is not an exact global count or facet set.
  const secondPageRequest = req({}, request.url + "?page=2");
  assert.equal(eligibleSyntheticR2Page(secondPageRequest, env), true);
  returned = rows(Array.from({ length: 49 }, (_, i) => i));
  const beforePage2 = dbCalls;
  const secondPage = await syntheticR2PageWithLiveRights(secondPageRequest, env, () => now);
  assert.equal(
    dbCalls - beforePage2,
    1,
    "Page two normally uses one fresh 56-candidate primary read",
  );
  assert.equal(secondPage?.books.length, 24);
  assert.equal(secondPage?.books[0].productId, "perf-synth-24");
  assert.equal(secondPage.books[23].productId, "perf-synth-47");
  assert.equal(secondPage.hasMore, true);
  assert.equal(
    secondPage.books.some((book) => book.productId === "perf-synth-48"),
    false,
  );
  // Withdrawal of rank #1 shifts the page boundary rather than leaking an
  // old rank or charging the next candidate's current price to a stale book.
  returned = rows(Array.from({ length: 49 }, (_, i) => i + 1));
  const afterWithdrawal = await syntheticR2PageWithLiveRights(secondPageRequest, env, () => now);
  assert.equal(afterWithdrawal?.books[0].productId, "perf-synth-25");
  assert.equal(afterWithdrawal?.books[23].productId, "perf-synth-48");
  // Withdraw the first eight ranked titles: only 48 live candidates
  // remain in the fast 56-ID prefix. A NEW 96-ID primary query must fill
  // page two; never combine witnesses from different SQL statements.
  returned = rows(Array.from({ length: 49 }, (_, i) => i + 8));
  const beforeSparsePage2 = dbCalls;
  const sparsePage2 = await syntheticR2PageWithLiveRights(secondPageRequest, env, () => now);
  assert.equal(dbCalls - beforeSparsePage2, 2);
  assert.equal(sparsePage2?.books[0].productId, "perf-synth-32");
  assert.equal(sparsePage2?.books[23].productId, "perf-synth-55");
  failFallbackD1 = true;
  await assert.rejects(
    () => syntheticR2PageWithLiveRights(secondPageRequest, env, () => now),
    /fallback/,
    "A primary outage during the full-list refresh must deny page-two publication",
  );
  failFallbackD1 = false;
  returned = rows(Array.from({ length: 48 }, (_, i) => i));
  assert.equal(
    await syntheticR2PageWithLiveRights(secondPageRequest, env, () => now),
    null,
    "No 49th live witness: cannot claim a proven next page or global exhaustion",
  );
  // The global metadata generation is read ONCE from primary D1 inside
  // the same statement, and attached to all 24 visible rows. We deliberately
  // do not hydrate the invisible 49th witness's public presentation.
  const staleWitness = rows(Array.from({ length: 49 }, (_, i) => i));
  staleWitness[24].public_metadata_revision = "2";
  returned = staleWitness;
  assert.equal(
    await syntheticR2PageWithLiveRights(secondPageRequest, env, () => now),
    null,
    "Visible page-two license generation mismatch must deny publication",
  );
  returned = rows(Array.from({ length: 49 }, (_, i) => i));
  const secondStage = await handleSyntheticR2LiveRightsStage(secondPageRequest, {
    ...env,
    COVE_PUBLIC_PRESENTATION_CACHE: {
      get: async () => ({ text: async () => buildSyntheticDisplayObject(books, Date.now(), "1") }),
    },
  });
  assert.equal(secondStage.status, 200);
  const secondJson = await secondStage.json();
  assert.equal(secondJson.results.length, 24);
  assert.equal(secondJson.results[0].productId, "perf-synth-24");
  assert.equal(secondJson.releaseCertified, false);
  assert.equal(Object.hasOwn(secondJson, "count"), false, "Never fabricate global catalog counts");
  assert.equal(Object.hasOwn(secondJson, "facets"), false, "Never fabricate canonical facets");
  returned = rows(Array.from({ length: 25 }, (_, i) => i));

  // Sparse rights/offer loss beyond the 32-ID window must trigger exactly
  // one fresh full-list primary read. Never combine old positive witnesses.
  returned = rows(Array.from({ length: 25 }, (_, i) => i + 8));
  const beforeFallback = dbCalls;
  const fallback = await syntheticR2PageWithLiveRights(request, env, () => now);
  assert.equal(fallback?.books.length, 24);
  assert.equal(fallback.books[0].productId, "perf-synth-8");
  assert.equal(dbCalls - beforeFallback, 2, "Sparse page requires fresh 32+96 live D1 reads");
  failFallbackD1 = true;
  await assert.rejects(
    () => syntheticR2PageWithLiveRights(request, env, () => now),
    /fallback/,
    "D1 7429 on fallback must deny every positive presentation",
  );
  failFallbackD1 = false;
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  const good = await syntheticR2PageWithLiveRights(request, env, () => now);
  assert.equal(
    dbCalls,
    beforeFallback + 5,
    "Sparse fallback uses two fresh reads, failed fallback two, normal one",
  );
  assert.equal(good?.books.length, 24);
  assert.equal(good?.hasMore, true);
  assert.equal(good.books[0].offer.amountMinor, 599, "Price comes exclusively from D1");
  assert.equal(good.books[0].formats["image/jpeg"], books[0].formats["image/jpeg"]);
  assert.equal(good.books[0].contributors[0].name, "Synthetic author");
  assert.deepEqual(good.books[0].summaries, ["Public canonical summary"]);
  assert.equal(good.books[0].isbn13, "9780000000000");
  assert.equal(good.books[0].publisherDescription, "Sample descriptive publisher text");
  assert.equal(good.books[0].series[0].name, "Synthetic Series");
  assert.equal(good.books[0].pageEstimate, 244);
  assert.deepEqual(good.books[0].externalIdentifiers, {
    product: { gutenberg: "1" },
    edition: { edition: "edition-v2" },
    work: { work: "work-v3" },
  });
  assert.equal(good.books[0].sourceProject, "gutenberg");
  assert.equal(good.books[0].sourceUrl, "https://www.gutenberg.org/ebooks/1");
  assert.equal(good.books[0].sourceLicenseUrl, "https://www.gutenberg.org/policy/license.html");
  assert.equal(good.books[0].fileSizeBytes, 12345);
  assert.equal(good.books[0].epubVersion, "3.0");
  assert.equal(good.books[0].layout, "reflowable");
  assert.deepEqual(good.books[0].accessibility, {
    screenReaderCompatible: 1,
    accessModes: ["textual"],
  });
  assert.deepEqual(good.books[0].formatProfile, {
    epubVersion: "3",
    compatibilityClass: "reflowable",
  });
  assert.deepEqual(good.books[0].aiDisclosure, {
    policyVersion: "2026.1",
    textOrigin: "human",
    publicBadges: [{ key: "human", label: "Human written" }],
  });
  // A real metadata mutation advances a single primary D1 revision. R2
  // may have seconds left on its TTL but must NOT supply the old public
  // license or AI label. The current retail offer remains otherwise valid.
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].public_metadata_revision = "2";
  assert.equal(
    await syntheticR2PageWithLiveRights(request, env, () => now),
    null,
    "Any mismatch must deny the entire old public R2 generation",
  );
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].public_metadata_revision = null;
  assert.equal(
    await syntheticR2PageWithLiveRights(request, env, () => now),
    null,
    "Missing D1 generation cannot authorize an R2 snapshot",
  );
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  const oldSnapshot = JSON.parse(snapshot);
  delete oldSnapshot.publicMetadataRevision;
  const oldSnapshotBody = JSON.stringify(oldSnapshot);
  const originalMetadataGet = env.COVE_PUBLIC_PRESENTATION_CACHE.get;
  env.COVE_PUBLIC_PRESENTATION_CACHE.get = async () => ({
    size: oldSnapshotBody.length,
    text: async () => oldSnapshotBody,
  });
  assert.equal(await syntheticR2PageWithLiveRights(request, env, () => now), null);
  env.COVE_PUBLIC_PRESENTATION_CACHE.get = originalMetadataGet;
  for (const book of good.books) {
    assert.equal(book.subscriptionEligible, false, "Live primary supersedes cached book flag");
    assert.equal(book.libraryEligible, false, "Live primary supersedes cached library flag");
    assert.equal(book.downloadable, true, "Live primary sets edition display metadata only");
    assert.equal(book.releaseStatus, "available");
    assert.equal(book.drmStatus, "none");
    assert.equal(book.download_count, 17, "Download tally is from the current primary");
    assert.match(book.workId, /^work-synth-/);
    assert.deepEqual(book.readingAvailability, { state: "processing" });
    assert.equal(book.formats["application/epub+zip"], undefined);
  }

  // Reader availability must be derived from LIVE primary assets. A safe
  // public API route is never an entitlement and R2 stores no private EPUB
  // object key or signed origin. Preserve canonicalRowBook behavior for
  // stored, on-demand, source-only and unavailable assets.
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].has_epub_object = 1;
  returned[0].epub_storage_status = "failed";
  let reading = (await syntheticR2PageWithLiveRights(request, env, () => now)).books[0];
  assert.equal(reading.readingAvailability.state, "stored");
  assert.equal(reading.formats["application/epub+zip"], "/api/fore/books/public-0/epub");
  assert.equal(JSON.stringify(reading).includes("synthetic/private/epub-key"), false);

  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].has_epub_source = 1;
  reading = (await syntheticR2PageWithLiveRights(request, env, () => now)).books[0];
  assert.equal(reading.readingAvailability.state, "on-demand");
  assert.equal(reading.formats["application/epub+zip"], "/api/fore/books/public-0/epub");

  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].has_epub_source = 1;
  returned[0].source_external_id = "pgca_synthetic";
  reading = (await syntheticR2PageWithLiveRights(request, env, () => now)).books[0];
  assert.equal(reading.readingAvailability.state, "processing");
  assert.equal(reading.formats["application/epub+zip"], "/api/fore/books/public-0/epub");

  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].epub_storage_status = "unavailable";
  returned[0].has_epub_source = 1;
  reading = (await syntheticR2PageWithLiveRights(request, env, () => now)).books[0];
  assert.equal(reading.readingAvailability.state, "unavailable");
  assert.equal(reading.formats["application/epub+zip"], undefined);

  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].has_epub_object = null;
  assert.equal(
    await syntheticR2PageWithLiveRights(request, env, () => now),
    null,
    "Missing primary asset evidence must never imply a stored or readable edition",
  );
  returned = rows(Array.from({ length: 25 }, (_, i) => i));

  // Rich public metadata comes from R2 only. Corrupt or oversized detail is
  // rejected before any new grant; no stale document can confer rights.
  const originalGet = env.COVE_PUBLIC_PRESENTATION_CACHE.get;
  const corrupted = JSON.parse(snapshot);
  corrupted.items[0].externalIdentifiers = ["not", "a", "record"];
  const corruptedBody = JSON.stringify(corrupted);
  env.COVE_PUBLIC_PRESENTATION_CACHE.get = async () => ({
    size: corruptedBody.length,
    text: async () => corruptedBody,
  });
  assert.equal(await syntheticR2PageWithLiveRights(request, env, () => now), null);
  const oversized = JSON.parse(snapshot);
  oversized.items[0].accessibility = { summary: "a".repeat(24001) };
  const oversizedBody = JSON.stringify(oversized);
  env.COVE_PUBLIC_PRESENTATION_CACHE.get = async () => ({
    size: oversizedBody.length,
    text: async () => oversizedBody,
  });
  assert.equal(await syntheticR2PageWithLiveRights(request, env, () => now), null);
  env.COVE_PUBLIC_PRESENTATION_CACHE.get = originalGet;

  const unsafeDisclosure = JSON.parse(snapshot);
  unsafeDisclosure.items[0].aiDisclosure = ["unsafe", "disclosure"];
  const disclosureBody = JSON.stringify(unsafeDisclosure);
  env.COVE_PUBLIC_PRESENTATION_CACHE.get = async () => ({
    size: disclosureBody.length,
    text: async () => disclosureBody,
  });
  assert.equal(await syntheticR2PageWithLiveRights(request, env, () => now), null);
  env.COVE_PUBLIC_PRESENTATION_CACHE.get = originalGet;
  returned = rows(Array.from({ length: 25 }, (_, i) => i));

  // If the top candidate loses its retail offer, the live SELECT itself
  // must exclude it so candidate 26 fills the 25th witness slot; the R2
  // ranking is unchanged and cannot confer price or availability.
  returned = rows(Array.from({ length: 25 }, (_, i) => i + 1));
  const offerWithdrawn = await syntheticR2PageWithLiveRights(request, env, () => now);
  assert.equal(offerWithdrawn.books.length, 24);
  assert.equal(offerWithdrawn.books[0].productId, "perf-synth-1");
  assert.equal(
    offerWithdrawn.books.some((book) => book.productId === "perf-synth-0"),
    false,
  );
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].subscription_eligible = 2;
  assert.equal(
    await syntheticR2PageWithLiveRights(request, env, () => now),
    null,
    "Malformed primary subscription metadata must fail closed",
  );
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].downloadable = null;
  assert.equal(
    await syntheticR2PageWithLiveRights(request, env, () => now),
    null,
    "Absent primary download metadata must fail closed",
  );
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].offer_json = null;
  assert.equal(
    await syntheticR2PageWithLiveRights(request, env, () => now),
    null,
    "A malformed primary offer witness must fail closed",
  );
  returned = rows(
    Array.from({ length: 25 }, (_, i) => i),
    0,
  );
  assert.equal(
    (await syntheticR2PageWithLiveRights(request, env, () => now)).books[0].offer.amountMinor,
    0,
    "Current free price must never borrow the old amount",
  );
  // A revocation removes the retired ID, while a later current right-checked
  // candidate fills the page without any cached positive grant.
  returned = rows([
    ...Array.from({ length: 3 }, (_, i) => i),
    ...Array.from({ length: 22 }, (_, i) => i + 4),
  ]);
  const revoked = await syntheticR2PageWithLiveRights(request, env, () => now);
  assert.equal(
    revoked.books.some((b) => b.productId === "perf-synth-3"),
    false,
  );
  assert.equal(revoked.books.length, 24);
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[24] = { ...returned[23] };
  assert.equal(
    await syntheticR2PageWithLiveRights(request, env, () => now),
    null,
    "Duplicate D1 rows must never prove a 25th authorized item",
  );
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  [returned[0], returned[1]] = [returned[1], returned[0]];
  assert.equal(
    await syntheticR2PageWithLiveRights(request, env, () => now),
    null,
    "D1 order must agree with the verified public ranking",
  );
  returned = rows(Array.from({ length: 24 }, (_, i) => i));
  assert.equal(
    await syntheticR2PageWithLiveRights(request, env, () => now),
    null,
    "No 25th live witness",
  );
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].offer_json = null;
  assert.equal(await syntheticR2PageWithLiveRights(request, env, () => now), null, "No offer");
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].edition_id = "changed-edition";
  assert.equal(await syntheticR2PageWithLiveRights(request, env, () => now), null, "Stale edition");
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  primaryError = new Error("primary D1 resource window overload");
  await assert.rejects(() => syntheticR2PageWithLiveRights(request, env, () => now), /overload/);
  // The handler uses real Date.now(), unlike helper tests with a fixed
  // future clock. Use a currently valid R2 object so the error reaches D1.
  const currentRouteEnv = {
    ...env,
    COVE_PUBLIC_PRESENTATION_CACHE: {
      get: async () => ({
        text: async () => buildSyntheticDisplayObject(books, Date.now(), "1"),
      }),
    },
  };
  primaryError = Object.assign(new Error("D1_ERROR: 7429 too many resources"), { code: 7429 });
  const overloaded = await handleSyntheticR2LiveRightsStage(request, currentRouteEnv);
  assert.equal(overloaded.status, 503);
  assert.equal(overloaded.headers.get("x-cove-stage-failure-class"), "d1-7429-resource-window");
  assert.equal(await overloaded.text(), "", "Never return upstream D1 exception details");
  primaryError = new Error("secret SQL data must never leak");
  const masked = await handleSyntheticR2LiveRightsStage(request, currentRouteEnv);
  assert.equal(masked.status, 503);
  assert.equal(masked.headers.get("x-cove-stage-failure-class"), "primary-or-stage-failure");
  assert.equal(await masked.text(), "", "Private trace classes exclude sensitive data");
  primaryError = null;

  const prev = dbCalls;
  for (const denied of [
    req({ cookie: "session=yes" }),
    req({ authorization: "Bearer test" }),
    req({ "x-cove-client-country": "CA" }),
    req({ "x-cove-backend-token": "b".repeat(64) }),
    req({}, "https://covereads.com/api/fore/__perf/private-r2-live-rights"),
    req({}, request.url + "?page=1"),
    req({}, request.url + "?page=02"),
    req({}, request.url + "?page=3"),
    req({}, request.url + "?page=2&sort=popular"),
    req({}, request.url + "?cursor=" + stageBody.nextCursor + "&sort=popular"),
    req(
      {},
      "https://cove-presentation-r2-proof-20261114.cove-jibrilmohamud.workers.dev/api/fore/__perf/private-r2-live-rights?sort=popular",
    ),
  ])
    assert.equal(await syntheticR2PageWithLiveRights(denied, env, () => now), null);
  assert.equal(
    await syntheticR2PageWithLiveRights(
      request,
      { ...env, FORE_GUEST_R2_DISPLAY_STAGE: "0" },
      () => now,
    ),
    null,
  );
  assert.equal(
    await syntheticR2PageWithLiveRights(
      request,
      { ...env, COVE_SYNTHETIC_STAGING_ONLY: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
      () => now,
    ),
    null,
  );
  assert.equal(dbCalls, prev, "No denied probe may touch D1");
  assert.equal(
    await syntheticR2PageWithLiveRights(
      request,
      {
        ...env,
        COVE_PUBLIC_PRESENTATION_CACHE: {
          get: async () => ({ etag: "x", text: async () => snapshot }),
        },
      },
      () => now + 120_001,
    ),
    null,
    "Expired R2 cannot serve a positive grant",
  );
  const injected = JSON.parse(snapshot);
  injected.items[0].offer = { amountMinor: 0 };
  assert.equal(
    await syntheticR2PageWithLiveRights(
      request,
      {
        ...env,
        COVE_PUBLIC_PRESENTATION_CACHE: {
          get: async () => ({ etag: "x", text: async () => JSON.stringify(injected) }),
        },
      },
      () => now,
    ),
    null,
    "Unexpected offer/grant keys in R2 must invalidate object",
  );
  assert.equal(dbCalls, prev, "Invalid display object never authorizes via D1");
  assert.doesNotMatch(
    buildSyntheticDisplayObject(
      [{ ...books[0], formats: { "image/jpeg": "javascript:attack" } }, ...books.slice(1)],
      now,
      "1",
    ),
    /javascript:attack/,
    "An unsafe cover URL is filtered rather than stored in the display cache",
  );
  console.log(
    "PASS: stage-only R2 display gate, page-one 25th and page-two 49th live witnesses, withdrawal, no invented count/facets or cached grants",
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
