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
  const { buildSyntheticDisplayObject, eligibleSyntheticR2Page, syntheticR2PageWithLiveRights } =
    await import(path.join(dir, "presentation.mjs"));
  const books = Array.from({ length: 96 }, (_, i) => ({
    id: "public-" + i,
    productId: "perf-synth-" + i,
    editionId: "edition-synth-" + i,
    title: "Stage book " + i,
    subtitle: "Only public description",
    authors: [{ name: "Synthetic author" }],
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
  const snapshot = buildSyntheticDisplayObject(books, now);
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

  const GATE = "a".repeat(64);
  let dbCalls = 0;
  let returned = [];
  let primaryError = null;
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
        assert.match(sql, /retail_product_availability_rows/);
        assert.match(sql, /FROM offers o/);
        assert.doesNotMatch(sql, /\\b(?:INSERT|UPDATE|DELETE|REPLACE)\\b/i);
        return {
          bind(...params) {
            assert.equal(params[0], "US");
            assert.equal(JSON.parse(params[1]).length, 96);
            assert.deepEqual(params.slice(2), ["USD", "USD", "US"]);
            return {
              async all() {
                if (primaryError) throw primaryError;
                return { results: returned };
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
  const good = await syntheticR2PageWithLiveRights(request, env, () => now);
  assert.equal(dbCalls, 1, "Every successful response must reach current primary D1");
  assert.equal(good?.books.length, 24);
  assert.equal(good?.hasMore, true);
  assert.equal(good.books[0].offer.amountMinor, 599, "Price comes exclusively from D1");
  assert.equal(good.books[0].formats["image/jpeg"], books[0].formats["image/jpeg"]);
  for (const book of good.books) {
    assert.equal(book.subscriptionEligible, undefined);
    assert.equal(book.libraryEligible, undefined);
    assert.equal(book.downloadable, undefined);
    assert.equal(book.readingAvailability, undefined);
    assert.equal(book.formats["application/epub+zip"], undefined);
  }

  returned = rows(Array.from({ length: 25 }, (_, i) => i), 0);
  assert.equal(
    (await syntheticR2PageWithLiveRights(request, env, () => now)).books[0].offer.amountMinor,
    0,
    "Current free price must never borrow the old amount",
  );
  // A revocation removes the retired ID, while a later current right-checked
  // candidate fills the page without any cached positive grant.
  returned = rows([...Array.from({ length: 3 }, (_, i) => i), ...Array.from({ length: 22 }, (_, i) => i + 4)]);
  const revoked = await syntheticR2PageWithLiveRights(request, env, () => now);
  assert.equal(revoked.books.some((b) => b.productId === "perf-synth-3"), false);
  assert.equal(revoked.books.length, 24);
  returned = rows(Array.from({ length: 24 }, (_, i) => i));
  assert.equal(await syntheticR2PageWithLiveRights(request, env, () => now), null, "No 25th live witness");
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].offer_json = null;
  assert.equal(await syntheticR2PageWithLiveRights(request, env, () => now), null, "No offer");
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  returned[0].edition_id = "changed-edition";
  assert.equal(await syntheticR2PageWithLiveRights(request, env, () => now), null, "Stale edition");
  returned = rows(Array.from({ length: 25 }, (_, i) => i));
  primaryError = new Error("primary D1 resource window overload");
  await assert.rejects(() => syntheticR2PageWithLiveRights(request, env, () => now), /overload/);
  primaryError = null;

  const prev = dbCalls;
  for (const denied of [
    req({ cookie: "session=yes" }),
    req({ authorization: "Bearer test" }),
    req({ "x-cove-client-country": "CA" }),
    req({ "x-cove-backend-token": "b".repeat(64) }),
    req({}, "https://covereads.com/api/fore/__perf/private-r2-live-rights"),
    req({}, "https://cove-presentation-r2-proof-20261114.cove-jibrilmohamud.workers.dev/api/fore/__perf/private-r2-live-rights?sort=popular"),
  ]) assert.equal(await syntheticR2PageWithLiveRights(denied, env, () => now), null);
  assert.equal(await syntheticR2PageWithLiveRights(request, { ...env, FORE_GUEST_R2_DISPLAY_STAGE: "0" }, () => now), null);
  assert.equal(await syntheticR2PageWithLiveRights(request, { ...env, COVE_SYNTHETIC_STAGING_ONLY: "4bd657ac-8789-403e-a28c-93aba8d0a989" }, () => now), null);
  assert.equal(dbCalls, prev, "No denied probe may touch D1");
  assert.equal(
    await syntheticR2PageWithLiveRights(
      request,
      { ...env, COVE_PUBLIC_PRESENTATION_CACHE: { get: async () => ({ etag: "x", text: async () => snapshot }) } },
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
      { ...env, COVE_PUBLIC_PRESENTATION_CACHE: { get: async () => ({ etag: "x", text: async () => JSON.stringify(injected) }) } },
      () => now,
    ),
    null,
    "Unexpected offer/grant keys in R2 must invalidate object",
  );
  assert.equal(dbCalls, prev, "Invalid display object never authorizes via D1");
  assert.throws(
    () => buildSyntheticDisplayObject([{ ...books[0], formats: { "image/jpeg": "javascript:attack" } }, ...books.slice(1)], now),
    /Unsafe display-only snapshot/,
  );
  console.log(
    "PASS: stage-only R2 display gate, fresh D1 market/territory/retail offer, withdrawal, 25th witness, no cached grants",
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
