import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-music-supply-"));
try {
  fs.mkdirSync(path.join(root, "drizzle"));
  fs.copyFileSync(
    "infra/music/0001_isolated_music_supply.sql",
    path.join(root, "drizzle", "0001_isolated_music_supply.sql"),
  );
  await build({
    entryPoints: ["src/music-supply/policy.ts", "src/music-supply/worker.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { validateMusicContract, validateMusicMaster, validateMusicQuality } = await import(
    path.join(root, "policy.mjs")
  );
  const worker = (await import(path.join(root, "worker.mjs"))).default;
  const isolated = localBindings(root);
  const objects = new Map();
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const bucket = {
    async put(key, body, options = {}) {
      const bytes =
        typeof body === "string"
          ? Buffer.from(body)
          : body?.getReader
            ? Buffer.from(await new Response(body).arrayBuffer())
            : Buffer.from(body);
      const actual = sha(bytes);
      if (options.sha256 && options.sha256 !== actual) throw Error("Checksum mismatch");
      objects.set(key, { bytes, sha256: actual });
    },
    async head(key) {
      const row = objects.get(key);
      return row
        ? { size: row.bytes.length, checksums: { sha256: Buffer.from(row.sha256, "hex") } }
        : null;
    },
    async get(key) {
      const row = objects.get(key);
      return row ? { size: row.bytes.length, body: new Blob([row.bytes]).stream() } : null;
    },
  };
  const keys = {
    operator: "operator-" + "a".repeat(56),
    reviewer: "reviewer-" + "b".repeat(56),
    ingest: "ingest-" + "c".repeat(56),
    qa: "qa-" + "d".repeat(56),
  };
  const env = {
    MUSIC_DB: isolated.DB,
    MUSIC_BUCKET: bucket,
    MUSIC_SUPPLY_ENABLED: "0",
    MUSIC_OPERATOR_TOKEN_SHA256: sha(keys.operator),
    MUSIC_LICENSE_REVIEWER_TOKEN_SHA256: sha(keys.reviewer),
    MUSIC_INGEST_TOKEN_SHA256: sha(keys.ingest),
    MUSIC_QA_TOKEN_SHA256: sha(keys.qa),
  };
  async function invoke(uri, method, token, body) {
    const request = new Request("https://music.qa.test" + uri, {
      method,
      headers: {
        ...(token ? { authorization: "Bearer " + keys[token] } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await worker.fetch(request, env);
    return { status: response.status, result: await response.json() };
  }
  assert.equal((await invoke("/health", "GET")).result.processingEnabled, false);
  assert.equal((await invoke("/v1/contracts", "POST", "operator", {})).status, 503);
  env.MUSIC_SUPPLY_ENABLED = "1";
  assert.equal((await invoke("/v1/contracts", "POST", undefined, {})).status, 401);
  const ref = await invoke("/v1/evidence/supplier-1", "POST", "operator", {
    contractId: "supplier-1",
    licensor: "Example Rights Holder",
    authorizingInstrument: "Synthetic fixture reviewed distribution agreement",
    commercialStreaming: true,
    masterRights: true,
    compositionRights: true,
  });
  assert.equal(ref.status, 201);
  const contract = {
    id: "supplier-1",
    provider: "Fixture Rights Publisher",
    licensedOrigin: "https://licensed.example.test/files/",
    territories: ["US", "CA"],
    expiresAt: "2035-02-01T00:00:00.000Z",
    evidenceKey: ref.result.evidenceKey,
    evidenceSha256: ref.result.evidenceSha256,
    commercialStreaming: true,
    masterRights: true,
    performanceRights: true,
    compositionRights: true,
    arrangementRights: true,
    lyricsRights: true,
  };
  for (const badOrigin of [
    "https://127.0.0.1/files/",
    "https://169.254.169.254/files/",
    "https://[::1]/files/",
    "https://metadata.google.internal/files/",
    "https://localhost/files/",
  ]) {
    assert.throws(
      () => validateMusicContract({ ...contract, licensedOrigin: badOrigin }),
      /music_unsafe_source_url/,
    );
  }
  assert.equal(
    (await invoke("/v1/contracts", "POST", "operator", contract)).result.status,
    "pending",
  );
  const bytes = Buffer.alloc(4096, 44),
    checksum = sha(bytes);
  const manifest = {
    id: "fixture-master-1",
    contractId: contract.id,
    title: "Original Instrumental Test",
    composer: "Fixture Composer",
    performer: "Fixture Performer",
    workKey: "fixture-work-1",
    sha256: checksum,
    bytes: bytes.length,
    mime: "audio/ogg",
    territory: ["US"],
    hasVocals: false,
    sourceUrl: "https://licensed.example.test/files/master-1.ogg",
    sourceLicenseId: "signed-line-item-1",
    attribution: "Fixture composer & performer — original test master",
  };
  assert.equal((await invoke("/v1/masters", "POST", "ingest", manifest)).status, 409);
  assert.equal(
    (await invoke("/v1/contracts/supplier-1/activate", "POST", "operator", {})).status,
    401,
  );
  assert.equal(
    (
      await invoke("/v1/contracts/supplier-1/activate", "POST", "reviewer", {
        reviewer: "legal-qa",
        reviewReference: "signed-evidence-synthetic-2026",
        evidenceSha256: contract.evidenceSha256,
        confirmedFiveLayers: true,
      })
    ).status,
    200,
  );
  assert.equal((await invoke("/v1/masters", "POST", "ingest", manifest)).status, 201);
  assert.equal((await invoke("/v1/masters", "POST", "ingest", manifest)).result.created, false);
  assert.throws(
    () =>
      validateMusicMaster({ ...manifest, territory: ["FR"] }, { ...contract, status: "active" }),
    /covered/,
  );
  assert.throws(
    () =>
      validateMusicMaster(
        { ...manifest, sourceUrl: "https://evil.example/files/1" },
        { ...contract, status: "active" },
      ),
    /outside/,
  );
  assert.throws(
    () => validateMusicQuality({ sha256: checksum }, checksum, bytes.length),
    /quality/,
  );
  const fakeAudio = new Request("https://music.qa.test/v1/masters/fixture-master-1/audio", {
    method: "PUT",
    headers: {
      authorization: "Bearer " + keys.ingest,
      "content-type": "audio/ogg",
      "content-length": String(bytes.length),
    },
    body: bytes,
  });
  assert.equal((await worker.fetch(fakeAudio, env)).status, 200);
  const queue = await invoke("/v1/qa/staged", "GET", "qa");
  assert.equal(queue.status, 200);
  assert.equal(queue.result.items[0].id, manifest.id);
  assert.equal((await invoke("/v1/qa/staged", "GET", "ingest")).status, 401);
  const privateRead = await worker.fetch(
    new Request("https://music.qa.test/v1/qa/masters/" + manifest.id + "/audio", {
      headers: { authorization: "Bearer " + keys.qa },
    }),
    env,
  );
  assert.equal(privateRead.status, 200);
  assert.equal(sha(Buffer.from(await privateRead.arrayBuffer())), checksum);
  const unauthorizedRead = await worker.fetch(
    new Request("https://music.qa.test/v1/qa/masters/" + manifest.id + "/audio"),
    env,
  );
  assert.equal(unauthorizedRead.status, 401);
  assert.equal(
    (await invoke("/v1/masters/fixture-master-1/quality", "POST", "operator", {})).status,
    401,
  );
  const report = {
    sha256: checksum,
    bytes: bytes.length,
    decodedFully: true,
    durationSeconds: 180,
    integratedLufs: -22,
    truePeakDbfs: -2,
    silenceRatio: 0.01,
    clippedSampleRatio: 0,
  };
  assert.equal(
    (await invoke("/v1/masters/fixture-master-1/quality", "POST", "qa", report)).status,
    202,
  );
  const market = await invoke("/v1/operator/preview-catalog?territory=US", "GET", "operator");
  assert.equal(market.status, 200);
  assert.equal(market.result.scope, "isolated_qualified_nonpublic");
  assert.equal(market.result.items.length, 1);
  assert.equal(market.result.items[0].id, manifest.id);
  assert.equal(market.result.items[0].quietSuitability, "unverified");
  assert.equal(
    (await invoke("/v1/operator/preview-catalog?territory=CA", "GET", "operator")).result.items
      .length,
    0,
  );
  assert.equal((await invoke("/v1/operator/preview-catalog", "GET", "ingest")).status, 401);
  const first = await invoke("/v1/operator/outbox?limit=1", "GET", "operator");
  assert.equal(first.result.items[0].action, "master_qualified");
  assert.equal(first.result.items[0].publishable, 1);
  const cursor = first.result.nextCursor;
  assert.equal(
    (await invoke("/v1/operator/outbox?after=" + cursor, "GET", "operator")).result.items.length,
    0,
  );
  assert.equal(
    (
      await invoke("/v1/masters/fixture-master-1/revoke", "POST", "reviewer", {
        reason: "Synthetic recording rights withdrawal",
      })
    ).status,
    200,
  );
  const rescanned = await invoke("/v1/operator/preview-catalog?territory=US", "GET", "operator");
  assert.equal(rescanned.result.items.length, 0, "Revoked masters cannot survive projection");
  const removed = await invoke("/v1/operator/outbox?after=" + cursor, "GET", "operator");
  assert.equal(removed.result.items[0].action, "master_revoked");
  const masterCursor = removed.result.nextCursor;
  assert.equal(
    (
      await invoke("/v1/contracts/supplier-1/revoke", "POST", "reviewer", {
        reason: "Synthetic QA contract withdrawn",
      })
    ).status,
    200,
  );
  const withdrawn = await invoke("/v1/operator/outbox?after=" + masterCursor, "GET", "operator");
  assert.equal(withdrawn.result.items[0].action, "contract_revoked");
  const historical = await invoke("/v1/operator/outbox?limit=1", "GET", "operator");
  assert.equal(historical.result.items[0].publishable, 0);
  assert.equal(
    (
      await invoke("/v1/masters", "POST", "ingest", {
        ...manifest,
        id: "fixture-master-2",
        sha256: sha(Buffer.from("different")),
      })
    ).status,
    409,
  );
  assert.equal((await invoke("/v1/operator/outbox?after=abc", "GET", "operator")).status, 400);
  assert.equal((await invoke("/v1/operator/outbox?limit=NaN", "GET", "operator")).status, 400);
  // Primary customer D1, playback rights, and worker route bindings are absent.
  assert.equal(Object.prototype.hasOwnProperty.call(env, "DB"), false);
  console.log(
    "Isolated supply: contract dual review, exact master, QA, ordered outbox, revoked source, and fail-closed gates passed.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
