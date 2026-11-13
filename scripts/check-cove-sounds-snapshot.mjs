/* eslint-disable prettier/prettier -- Keep the evidence gates and failure assertions adjacent until source normalization. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

async function load(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint],
    platform: "node",
    target: "es2022",
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  return import("data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64"));
}
const { SOUNDS_SCHEMA, soundsKey, validateSoundsSnapshot, getSoundsSnapshot, handleSoundsSnapshot } =
  await load("src/features/fore/cove-sounds-snapshot.server.ts");
const { publishCoveSounds, withTransientD1PublicationRetry } = await load("src/storefront-strangler/sounds-publication.worker.ts");
const at = Date.now();
const recording = {
  id: "cm_7", title: "Gothic Nocturne", composer: "Composer", performer: "Performer",
  period: "romantic", instruments: ["piano"], moods: ["dark"], energy: 0.25,
  hasVocals: false, attribution: "Example recording attribution",
  license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  sourcePage: "https://commons.wikimedia.org/wiki/File:Example.ogg",
  audioUrl: "/api/fore/soundtracks/recordings/cm_7/audio",
};
const sample = {
  schema: SOUNDS_SCHEMA,
  territory: "US",
  slug: "gothic-hour",
  currency: "USD",
  generatedAt: at,
  expiresAt: at + 75 * 60_000,
  recordings: [recording],
  candidateProductIds: [],
};
assert.equal(soundsKey("US", "gothic-hour"), "sounds/v1/US/gothic-hour.json");
assert.throws(() => soundsKey("ZZ", "not-a-station"));
assert.equal(validateSoundsSnapshot(sample, "US", sample.slug, at).recordings.length, 1);
assert.throws(() => validateSoundsSnapshot(sample, "GB", sample.slug, at));
assert.throws(() => validateSoundsSnapshot({ ...sample, expiresAt: at - 1 }, "US", sample.slug, at));
assert.throws(() => validateSoundsSnapshot({ ...sample, recordings: [
  { ...recording, id: "cm_8", audioUrl: "/admin/staged/master" },
] }, "US", sample.slug, at));
assert.throws(() => validateSoundsSnapshot({ ...sample, candidateProductIds: Array(13).fill("x") }, "US", sample.slug, at));
const store = { async get(key) {
  assert.equal(key, soundsKey("US", "gothic-hour"));
  const body = JSON.stringify(sample);
  return { size: new TextEncoder().encode(body).byteLength, text: async () => body };
} };
const env = {
  COVE_SOUNDS_SNAPSHOT_ENABLED: "1",
  SOUNDS_PRESENTATION: store,
  SOUNDS_PRESENTATION_KV: { async get() { return "stale"; } },
  DB: { prepare(sql) {
    assert.match(sql, /status='ready'/);
    return { bind(...params) {
      assert.equal(params[1], "US");
      return { async all() { return { results: [{ id: "cm_7" }] }; } };
    } };
  } },
};
assert.equal((await getSoundsSnapshot(env, "US", sample.slug, at)).slug, sample.slug);
const request = new Request("https://test.invalid/api/fore/sounds/stations/gothic-hour/recordings");
const result = await handleSoundsSnapshot(request, env, "/sounds/stations/gothic-hour/recordings", "US");
assert.equal(result.status, 200);
const body = await result.json();
assert.deepEqual(body.recordings.map((r) => r.id), ["cm_7"]);
const revoked = await handleSoundsSnapshot(request, {
  ...env,
  DB: { prepare() { return { bind() { return { async all() { return { results: [] }; } }; } }; } },
}, "/sounds/stations/gothic-hour/recordings", "US");
assert.equal(revoked.status, 200);
assert.deepEqual((await revoked.json()).recordings, [],
  "A stale KV/R2 hint must NEVER reinstate an immediately revoked recording");

const fallback = await handleSoundsSnapshot(request, {
  ...env, COVE_SOUNDS_SNAPSHOT_ENABLED: "0", SOUNDS_PRESENTATION: undefined,
}, "/sounds/stations/gothic-hour/recordings", "US");
assert.equal((await fallback.json()).fallback, true);
await assert.rejects(
  () => getSoundsSnapshot({ SOUNDS_PRESENTATION: { get: async () => null } }, "US", sample.slug, at),
  /refreshed/,
);
const stale = { ...sample, expiresAt: at - 1 };
const cached = await getSoundsSnapshot({
  SOUNDS_PRESENTATION_KV: { get: async () => JSON.stringify(stale) },
  SOUNDS_PRESENTATION: store,
}, "US", sample.slug, at);
assert.equal(cached.generatedAt, at);
// The publisher has no native D1 binding. Mock the actual private Worker
// RPC contract so publication tests still exercise the same four SQL reads.
const testedReadService = (db) => ({
  async query(statements) {
    assert.equal(statements.length, 1, "Every advisory read uses bounded primary-only RPC");
    return await Promise.all(statements.map(async ({ sql, params }) => {
      const result = await db.prepare(sql).bind(...params).all();
      return { ...result, success: true, meta: { served_by_primary: true } };
    }));
  },
});
// Producer guarantees per-station, bounded, rights-*advisory* publication.
const writes = new Map();
const published = await publishCoveSounds({
  COVE_SOUNDS_PUBLICATION_ENABLED: "1",
  COVE_SOUNDS_MARKETS: "US",
  COVE_CANONICAL_READONLY_RPC: "1",
  COVE_CANONICAL_READONLY: testedReadService({ prepare(sql) {
    return { bind() { return this; }, async all() {
      if (sql.includes("FROM storefront_markets")) return { results: [{ currency: "USD" }] };
      if (sql.includes("FROM soundtrack_recordings")) return { results: [{
        id: "cm_7", title: "Gothic Nocturne", composer: "Composer", performer: "Performer",
        period: "romantic", instruments_json: '["piano"]', moods_json: '["dark"]',
        energy: 0.25, has_vocals: 0, attribution_text: "Example recording attribution",
        source_page_url: recording.sourcePage, license_statement: recording.license,
        license_url: recording.licenseUrl, territories_json: '["US"]',
      }] };
      return { results: [] };
    } };
  } }),
  SOUNDS_PRESENTATION: { async put(key, body) { writes.set(key, body); } },
  SOUNDS_PRESENTATION_KV: { async put(key, body) {
    assert.equal(writes.get(key), body, "Durable R2 write must precede KV acceleration");
  } },
}, at);
// Production source DB is shared: never execute its independent publication
// reads simultaneously or burst the ten-second resource-window budget.
const fakeDBReads = [];
let inFlightReads = 0;
const checkOrder = await publishCoveSounds({
  COVE_SOUNDS_PUBLICATION_ENABLED: "1",
  COVE_SOUNDS_MARKETS: "US",
  COVE_CANONICAL_READONLY_RPC: "1",
  COVE_CANONICAL_READONLY: testedReadService({ prepare(sql) {
    return { bind() { return this; }, async all() {
      inFlightReads++;
      assert.equal(inFlightReads, 1, "Concurrent source-D1 queries risk quota overload");
      fakeDBReads.push(sql.includes("storefront_markets") ? "market" :
        sql.includes("FROM soundtrack_recordings") ? "commons" :
        sql.includes("FROM soundtrack_external_recordings") ? "external" : "editions");
      await Promise.resolve();
      inFlightReads--;
      if (sql.includes("FROM storefront_markets")) return { results: [{ currency: "USD" }] };
      return { results: [] };
    } };
  } }),
  SOUNDS_PRESENTATION: { async put() {} },
}, at);
assert.equal(checkOrder.length, 1);
assert.deepEqual(fakeDBReads, ["market", "commons", "external", "editions"],
  "Source queries must run serially, with rights validation before any publication");
let attempts = 0;
const waited = [], reported = [];
const retryResult = await withTransientD1PublicationRetry(
  async () => { if (++attempts < 3) throw Error("D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window"); return "published"; },
  async (ms) => { waited.push(ms); },
  (n) => reported.push(n),
);
assert.equal(retryResult, "published");
assert.equal(attempts, 3);
assert.deepEqual(waited, [12_000, 15_000], "D1 retries must wait beyond quota reset");
assert.deepEqual(reported, [1, 2]);
let forbiddenAttempts = 0;
await assert.rejects(
  () => withTransientD1PublicationRetry(
    async () => { forbiddenAttempts++; throw Error("Unqualified Cove Sounds snapshot tracks"); },
    async () => { throw Error("Must not retry legal denials"); },
  ),
  /Unqualified/,
);
assert.equal(forbiddenAttempts, 1, "Non-transient rights validation must fail immediately");
let persistentAttempts = 0;
await assert.rejects(
  () => withTransientD1PublicationRetry(async () => {
    persistentAttempts++;
    throw Error("D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window");
  }, async () => {}),
  /overloaded/,
);
assert.equal(persistentAttempts, 3, "Bounded retries must fail closed");
assert.equal(published.length, 1);
assert.equal(published[0].stations, 6);
assert.equal(writes.size, 6);
assert.equal(JSON.parse(writes.get(soundsKey("US", sample.slug))).recordings[0].id, "cm_7");
// Explicitly configured non-US discovery must fail CLOSED before any private
// R2/KV write if the authoritative source has no usable regional grants.
const overseasWrites = [];
await assert.rejects(() => publishCoveSounds({
  COVE_SOUNDS_PUBLICATION_ENABLED: "1",
  COVE_SOUNDS_MARKETS: "GB",
  COVE_CANONICAL_READONLY_RPC: "1",
  COVE_CANONICAL_READONLY: testedReadService({ prepare(sql) {
    return { bind() { return this; }, async all() {
      if (sql.includes("FROM storefront_markets")) return { results: [{ currency: "GBP" }] };
      return { results: [] };
    } };
  } }),
  SOUNDS_PRESENTATION: { async put(key) { overseasWrites.push(key); } },
}, at), /territory not publication-ready: GB/);
assert.deepEqual(overseasWrites, [], "No empty overseas edition snapshot may be published");
await assert.rejects(
  () => publishCoveSounds({
    COVE_SOUNDS_PUBLICATION_ENABLED: "1",
    SOURCE_DB: { prepare() { throw Error("Forbidden raw D1"); } },
    COVE_CANONICAL_READONLY_RPC: "1",
    COVE_CANONICAL_READONLY: { async query() { return []; } },
    SOUNDS_PRESENTATION: { async put() { throw Error("Must not publish"); } },
  }),
  /sounds_publication_readonly_binding_required/,
  "Native production D1 must be rejected even when a read service exists",
);
const failClosedKeys = [];
await assert.rejects(
  () => publishCoveSounds({
    COVE_SOUNDS_PUBLICATION_ENABLED: "1",
    COVE_SOUNDS_MARKETS: "US",
    COVE_CANONICAL_READONLY_RPC: "1",
    COVE_CANONICAL_READONLY: { async query() { throw Error("Provider read unavailable"); } },
    SOUNDS_PRESENTATION: { async put(key) { failClosedKeys.push(key); } },
  }),
  /Provider read unavailable/,
);
assert.deepEqual(failClosedKeys, [], "A read-service outage cannot publish stale or guessed data");
await assert.rejects(() => publishCoveSounds({ COVE_SOUNDS_PUBLICATION_ENABLED: "0" }), /disabled/);
const analytics = readFileSync("src/features/fore/cove-sounds-analytics.server.ts", "utf8");
assert.ok(analytics.includes("writeDataPoint"));
assert.ok(!analytics.includes(".DB.prepare("), "No primary-D1 event writes");
const app = readFileSync("src/features/fore/CoveSounds.tsx", "utf8");
assert.ok(app.includes("/sounds/stations/"));
assert.ok(app.includes('event: "music_open"') || app.includes('"music_open"'));
assert.ok(app.includes("navigator.doNotTrack"));
assert.ok(app.includes('credentials: "omit"'));
assert.ok(app.includes('isolated.fallback'), "Controlled disabled-mode fallback required");
const api = readFileSync("src/features/fore/api.server.ts", "utf8");
assert.ok(api.includes("isSoundsAnalyticsAck(tracedRequest, response)"));
assert.ok(api.includes("handleSoundsSnapshot(request"));
console.log("PASS: isolated six-station snapshots, stale/market validation, canonical live rights, R2-first KV, disabled fallback, no primary-D1 click logging");
