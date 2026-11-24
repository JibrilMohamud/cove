/** Local native workerd test of the actual production-mode candidate, using
 * only synthetic isolated database and R2 resource IDs. No provider access. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.url)(
  process.env.COVE_MINIFLARE_MODULE || "miniflare",
);
const directory = mkdtempSync(join(tmpdir(), "cove-production-mode-local-"));
const primaryLabel = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const localPrimary = "11111111-1111-4111-8111-111111111111";
const localLiterary = "22222222-2222-4222-8222-222222222222";
const backendToken = "fixture-production-backend-auth-00000000";
const biosyncToken = "c".repeat(64);
const ownerSecret = "a".repeat(64);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tokenHash = digest(backendToken);
const biosyncHash = digest(biosyncToken);
function compactSql(input) {
  let out = "",
    quote = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i],
      next = input[i + 1];
    if (quote) {
      assert.ok(c !== "\n" && c !== "\r", "Multiline literal needs explicit migration handling");
      out += c;
      if (c === quote) {
        if (next === quote) {
          out += next;
          i++;
        } else quote = null;
      }
    } else if (c === "-" && next === "-") {
      while (i < input.length && input[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = input.indexOf("*/", i + 2);
      assert.ok(end >= 0);
      i = end + 1;
      out += " ";
    } else if (c === "'" || c === '\"' || c === "`" || c === "[") {
      quote = c === "[" ? "]" : c;
      out += c;
    } else out += c === "\n" || c === "\r" ? " " : c;
  }
  assert.equal(quote, null);
  return out;
}

// Pinned Wrangler workerd supports dates through October 19. Production
// deployment remains October 25; this test is only local runtime evidence.
const options = {
  workers: [
    {
      name: "gateway",
      modules: true,
      scriptPath: resolve(".output/production-consolidation/gateway.mjs"),
      compatibilityDate: "2026-10-17",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        COVE_PRODUCTION_PERSISTENCE_GATEWAY_ENABLED: "1",
        FORE_ENVIRONMENT: "production",
        FORE_BACKEND_TOKEN_SHA256: tokenHash,
        COVE_BIOSYNC_CLIENT_TOKEN_SHA256: biosyncHash,
      },
      serviceBindings: { BUSINESS_OWNER: { name: "owner", entrypoint: "CoveBusinessEntrypoint" } },
    },
    {
      name: "owner",
      modules: true,
      scriptPath: resolve(".output/production-consolidation/owner.mjs"),
      compatibilityDate: "2026-10-17",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        COVE_PRODUCTION_PERSISTENCE_OWNER_ENABLED: "1",
        COVE_PRODUCTION_PERSISTENCE_BIOSYNC_ENABLED: "1",
        COVE_PRODUCTION_PERSISTENCE_CRON_ENABLED: "0",
        COVE_RIGHTS_OWNER_ENABLED: "0",
        COVE_RIGHTS_OWNER_PRIMARY_ID: primaryLabel,
        COVE_LEGAL_WRITER_PRIMARY_ID: primaryLabel,
        FORE_AUTH_MODE: "supabase",
        FORE_ENVIRONMENT: "production",
        FORE_BACKEND_TOKEN_SHA256: tokenHash,
        COVE_RIGHTS_OWNER_SECRET: ownerSecret,
        COVE_BIOSYNC_CLIENT_TOKEN_SHA256: biosyncHash,
      },
      d1Databases: { PRIMARY_DB: localPrimary, LITERARY_CONTENT_DB: localLiterary },
      r2Buckets: { BUCKET: "local-synthetic-biosync" },
      durableObjects: { LEGAL_AUTHORITY: { className: "CoveLegalAuthority", useSQLite: true } },
    },
  ].map((worker) => ({
    ...worker,
    outboundService: async () => {
      throw Error("external_network_forbidden");
    },
  })),
  resourcePersistencePath: join(directory, "resources"),
  isolatedResourcePersistencePath: join(directory, "isolated"),
  d1Persist: join(directory, "d1"),
  durableObjectsPersist: join(directory, "do"),
  r2Persist: join(directory, "r2"),
};
const edition = "fixture-production-biosync-edition";
const track = "01";
const job = "fixture-production-biosync-job";
const audioSha = "d".repeat(64);
const epubSha = "e".repeat(64);
const at = new Date().toISOString();
const map = {
  version: 2,
  status: "checked",
  trackId: track,
  audioSha256: audioSha,
  epubSha256: epubSha,
  engine: "cloudflare-workers-ai-whisper",
  duration: 30,
  verification: {
    method: "independent-asr-exact-text",
    confidenceMode: "unreported",
    minWordProbability: null,
    coverage: 1,
    matchedWords: 30,
    spokenWords: 30,
  },
  words: Array.from({ length: 30 }, (_, i) => ({
    wordIndex: i,
    href: "OPS/synthetic.xhtml",
    cfi: "epubcfi(/6/2!/4/2:" + i + ")",
    endCfi: "epubcfi(/6/2!/4/2:" + (i + 1) + ")",
    text: "synthetic",
    start: i * 0.9,
    end: i * 0.9 + 0.5,
    probability: null,
  })),
};
const bytes = JSON.stringify(map);
const mapSha = digest(bytes);
const command = { editionId: edition, trackId: track, jobId: job, mapSha256: mapSha };
let mf;
const open = () =>
  new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
try {
  mf = open();
  const db = await mf.getD1Database("PRIMARY_DB", "owner");
  const literary = await mf.getD1Database("LITERARY_CONTENT_DB", "owner");
  const migrations = readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations)
    await db.exec(compactSql(readFileSync(join("drizzle", name), "utf8")));
  await literary.exec("CREATE TABLE separate_literary_sentinel (id INTEGER PRIMARY KEY)");
  await literary.exec("INSERT INTO separate_literary_sentinel VALUES (1)");
  await db
    .prepare(
      "INSERT INTO audio_editions(id,gutenberg_id,book_id,title,authors_json,language,narration,narrator,source_url,rights,tracks_json,alignment_json,epub_sha256,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      edition,
      "synthetic-only",
      null,
      "Synthetic local fixture",
      "[]",
      "en",
      "synthetic",
      "",
      "https://fixture.invalid",
      "Synthetic fixture only",
      JSON.stringify([{ id: track, sha256: audioSha, duration: 30 }]),
      null,
      epubSha,
      at,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO audio_jobs(id,kind,payload_json,status,attempts,next_attempt_at,lease_token,lease_until,last_error,updated_at) VALUES(?,'align',?,'queued',0,?,NULL,NULL,'',?)",
    )
    .bind(
      job,
      JSON.stringify({ editionId: edition, trackId: track, audioSha256: audioSha }),
      at,
      at,
    )
    .run();
  const bucket = await mf.getR2Bucket("BUCKET", "owner");
  await bucket.put("biosync/maps/" + mapSha + ".json", bytes);
  let gateway = await mf.getWorker("gateway");
  const owner = await mf.getWorker("owner");
  const publish = (token, value = command) =>
    gateway.fetch("https://fixture.invalid/__cove/biosync/publish-checked", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  assert.equal((await publish(backendToken)).status, 401);
  assert.equal((await publish("wrong-client-token-not-valid")).status, 401);
  assert.equal(
    (await publish(biosyncToken, { ...command, mapSha256: "f".repeat(64) })).status,
    503,
  );
  assert.equal(
    (await db.prepare("SELECT status FROM audio_jobs WHERE id=?").bind(job).first()).status,
    "queued",
  );
  assert.equal(
    (
      await gateway.fetch("https://fixture.invalid/api/fore/catalog", {
        headers: { "x-cove-backend-token": backendToken },
      })
    ).status,
    503,
    "No unverified catalog allow",
  );
  assert.equal(
    (
      await gateway.fetch("https://fixture.invalid/__cove/health", {
        headers: { "x-cove-backend-token": backendToken },
      })
    ).status,
    200,
  );
  assert.notEqual(
    (
      await owner.fetch("https://fixture.invalid/biosync/publish-checked", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerSecret, "content-type": "application/json" },
        body: JSON.stringify(command),
      })
    ).status,
    200,
    "Default disabled owner cannot bypass named private business entrypoint",
  );
  const first = await publish(biosyncToken);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    schema: "cove.owner-biosync-checked-publication.v1",
    ...command,
    committed: true,
    replay: false,
  });
  const receipt = await publish(biosyncToken);
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), {
    schema: "cove.owner-biosync-checked-publication.v1",
    ...command,
    committed: true,
    replay: true,
  });
  assert.equal(
    (
      await db
        .prepare("SELECT map_sha256 FROM audio_timing WHERE edition_id=? AND track_id=?")
        .bind(edition, track)
        .first()
    ).map_sha256,
    mapSha,
  );
  assert.equal(
    (await db.prepare("SELECT status FROM audio_jobs WHERE id=?").bind(job).first()).status,
    "done",
  );
  assert.equal(
    (await literary.prepare("SELECT count(*) n FROM separate_literary_sentinel").first()).n,
    1,
  );
  assert.equal((await literary.prepare("SELECT count(*) n FROM sqlite_master WHERE name='audio_timing'").first()).n, 0);
  await mf.dispose();
  mf = open();
  gateway = await mf.getWorker("gateway");
  const afterRestart = await publish(biosyncToken);
  assert.equal(afterRestart.status, 200);
  assert.equal((await afterRestart.json()).replay, true);
  console.log(
    JSON.stringify({
      schema: "cove.production-mode-biosync-native.v1",
      migrations: migrations.length,
      gatewayNativeD1Bindings: 0,
      physicalPrimaryOwnerCount: 1,
      separateLiteraryStorageUntouched: true,
      committed: true,
      replayAfterRestart: true,
      protectedCatalogDenied: true,
      runtimeCompatibilityDate: "2026-10-17",
      productionAccess: false,
      releaseCertified: false,
    }),
  );
} finally {
  await mf?.dispose();
  rmSync(directory, { recursive: true, force: true });
}
