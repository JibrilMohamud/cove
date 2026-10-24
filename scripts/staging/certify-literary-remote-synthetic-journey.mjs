import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import JSZip from "jszip";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "24c0eda2-6a43-4d7e-b787-502745d4d781";
const content = "fce5742c-29ca-4bc3-85da-e174dd9bf42e";
const bucket = "cove-literary-cutover-qa-objects-20261024";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(token, "A protected staging credential is required");
assert.match(process.env.GITHUB_SHA || "", /^[0-9a-f]{40}$/);
const apiRoot = "https://api.cloudflare.com/client/v4/accounts/" + account;
const temporary = mkdtempSync(path.join(os.tmpdir(), "cove-literary-live-canary-"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let remoteStatements = 0;
let r2Puts = 0;
let aiCalls = 0;

async function api(endpoint, method = "GET", body, contentType = "application/json") {
  const response = await fetch(apiRoot + endpoint, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "content-type": contentType }),
    },
    ...(body === undefined
      ? {}
      : {
          body: contentType === "application/json" ? JSON.stringify(body) : body,
        }),
    signal: AbortSignal.timeout(45000),
  });
  if (contentType === "application/octet-stream") {
    if (response.status === 404) return null;
    assert.ok(response.ok, "Staged R2 object transfer failed " + response.status);
    return response;
  }
  assert.ok(response.ok, "Cloudflare stage API status " + response.status);
  const json = await response.json();
  assert.equal(json.success, true, "Cloudflare staging request failed");
  return json.result;
}
async function sql(db, statement, params = []) {
  remoteStatements++;
  const x = await api("/d1/database/" + db + "/query", "POST", {
    sql: statement,
    params,
  });
  assert.ok(Array.isArray(x) && x.every((v) => v.success), "Remote D1 statement failed");
  return x;
}
const database = (id) => ({
  prepare(statement) {
    const create = (params) => ({
      statement,
      params,
      bind(...next) {
        return create(next);
      },
      async first() {
        const r = await sql(id, statement, params);
        return r[0]?.results?.[0] ?? null;
      },
      async all() {
        const r = await sql(id, statement, params);
        return { results: r[0]?.results || [] };
      },
      async run() {
        const r = await sql(id, statement, params);
        return r[0];
      },
    });
    return create([]);
  },
  async batch(stmts) {
    remoteStatements += stmts.length;
    const response = await api("/d1/database/" + id + "/query", "POST", {
      batch: stmts.map((s) => ({ sql: s.statement, params: s.params })),
    });
    assert.ok(Array.isArray(response) && response.every((r) => r.success));
    return response;
  },
});
const DB = database(primary);
const CONTENT_DB = database(content);
const metadata = new Map();
const r2path = (key) =>
  "/r2/buckets/" + bucket + "/objects/" + key.split("/").map(encodeURIComponent).join("/");
const BUCKET = {
  async get(key) {
    const response = await api(r2path(key), "GET", undefined, "application/octet-stream");
    if (!response) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const options = metadata.get(key) || {};
    return {
      size: bytes.length,
      httpMetadata: options.httpMetadata || { contentType: response.headers.get("content-type") },
      customMetadata: options.customMetadata || {},
      async arrayBuffer() {
        return bytes.buffer;
      },
      async text() {
        return new TextDecoder().decode(bytes);
      },
    };
  },
  async head(key) {
    return this.get(key);
  },
  async put(key, data, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === "*" && (await this.head(key))) return null;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    await api(r2path(key), "PUT", bytes, "application/octet-stream");
    metadata.set(key, options);
    r2Puts++;
    return { etag: sha(bytes) };
  },
};
try {
  // The staging databases are dedicated to this synthetic run. Wipe only
  // tables inside those two named QA resources, never any production DB.
  for (const table of [
    "literary_prepare_outbox",
    "literary_profiles",
    "rights_grants",
    "gutenberg_source_cache",
    "products",
    "cove_runtime_config",
  ])
    await sql(primary, "DROP TABLE IF EXISTS " + table);
  for (const table of [
    "literary_inference_jobs",
    "literary_inference_seed_frontier",
    "literary_prepare_jobs",
    "literary_budget_cutover",
    "literary_profile_budget",
    "literary_budget_domain_identity",
    "literary_usage_records",
    "literary_output_settlement_receipts",
  ])
    await sql(content, "DROP TABLE IF EXISTS " + table);
  await sql(
    primary,
    "CREATE TABLE cove_runtime_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);" +
      "CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,source_name TEXT,source_external_id TEXT,format TEXT,storefront_status TEXT);" +
      "CREATE TABLE gutenberg_source_cache(id TEXT PRIMARY KEY,source_id TEXT,ingest_status TEXT,epub_status TEXT,rights_status TEXT,commercial_use_status TEXT,content_hash TEXT,rights_territories_json TEXT);" +
      "CREATE TABLE rights_grants(id TEXT PRIMARY KEY,edition_id TEXT,format TEXT,sales_channel TEXT,status TEXT,decision TEXT,source TEXT,territory_code TEXT,starts_at TEXT,ends_at TEXT);" +
      "CREATE TABLE literary_profiles(product_id TEXT PRIMARY KEY,fingerprint TEXT,revision INTEGER NOT NULL DEFAULT 0,profile_json TEXT,status TEXT,coverage TEXT,policy_version TEXT,updated_at TEXT);" +
      readFileSync("infra/content-budget/0004_literary_handoff_outbox_primary.sql", "utf8"),
  );
  for (const migration of [
    "infra/content-budget/0001_ledger.sql",
    "infra/content-budget/0002_preparation_queue.sql",
    "infra/content-budget/0005_literary_output_settlement_receipts.sql",
    "infra/content-budget/0006_isolated_inference.sql",
    "infra/content-budget/0007_inference_seed_frontier.sql",
    "infra/content-budget/0010_literary_private_publication_retries.sql",
  ])
    await sql(content, readFileSync(migration, "utf8"));

  await build({
    entryPoints: {
      handoff: "src/lib/literary-prepare-outbox.server.ts",
      prepare: "src/lib/literary-preparation-domain.server.ts",
      infer: "src/lib/literary-isolated-inference.server.ts",
      publish: "src/lib/literary-private-publication.server.ts",
      gateway: "src/literary-inference-publisher.worker.ts",
      profile: "src/features/fore/literary-profile.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: temporary,
    logLevel: "silent",
  });
  const handoff = await import(path.join(temporary, "handoff.js"));
  const prep = await import(path.join(temporary, "prepare.js"));
  const infer = await import(path.join(temporary, "infer.js"));
  const publisher = await import(path.join(temporary, "publish.js"));
  const gateway = await import(path.join(temporary, "gateway.js"));
  const { emptyLiteraryProfile, PROFILE_POLICY } = await import(path.join(temporary, "profile.js"));
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
  );
  zip.file(
    "book.opf",
    '<package><manifest><item id="a" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
  );
  zip.file(
    "chapter.xhtml",
    "<html><body><h1>Original Cove QA</h1>" +
      "The quiet lake reflected a pale sky. ".repeat(220) +
      "</body></html>",
  );
  const epub = await zip.generateAsync({ type: "uint8array" });
  const sourceHash = sha(epub);
  const profileFingerprint = "b".repeat(64);
  await BUCKET.put("epubs/pg_qa.epub", epub, {
    httpMetadata: { contentType: "application/epub+zip" },
    customMetadata: { sha256: sourceHash },
  });
  await DB.prepare(
    "INSERT INTO cove_runtime_config(key,value) VALUES('literary_processing_owner','draining')",
  ).run();
  await DB.prepare(
    "INSERT INTO cove_runtime_config(key,value) VALUES('literary_budget_domain','isolated')",
  ).run();
  await DB.prepare("INSERT INTO products VALUES(?,?,?,?,?,?)")
    .bind("qa_literary", "qa_edition", "gutenberg", "pg_qa", "ebook", "active")
    .run();
  await DB.prepare("INSERT INTO gutenberg_source_cache VALUES(?,?,?,?,?,?,?,?)")
    .bind("pg_qa", "qa", "active", "completed", "public-domain", "approved", sourceHash, '["AU"]')
    .run();
  await DB.prepare("INSERT INTO rights_grants VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(
      "qa_grant",
      "qa_edition",
      "ebook",
      "retail",
      "active",
      "allow",
      "gutenberg-qa-public-domain",
      "AU",
      null,
      null,
    )
    .run();
  await DB.prepare("INSERT INTO literary_profiles VALUES(?,?,?,?,?,?,?,?)")
    .bind(
      "qa_literary",
      profileFingerprint,
      0,
      "{}",
      "provisional",
      "metadata",
      PROFILE_POLICY,
      new Date().toISOString(),
    )
    .run();

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  await CONTENT_DB.prepare(
    "INSERT INTO literary_budget_cutover(day,status,original_reserved_units,original_calls,prepared_at,activated_at,operator_receipt) VALUES(?,'active',0,0,?,?,?)",
  )
    .bind(today, now, now, "synthetic-stage-no-live-budget")
    .run();

  const handoffEnv = {
    DB,
    CONTENT_DB,
    BUCKET,
    FORE_CONTENT_PROCESSOR_ENABLED: "1",
    FORE_CONTENT_PREPARE_ENABLED: "1",
    FORE_CONTENT_HANDOFF_ENABLED: "1",
    FORE_CONTENT_PROCESSOR_ROLE: "literary-handoff",
  };
  const original = await handoff.seedLiteraryPreparationHandoff(
    handoffEnv,
    "qa_literary",
    "qa_edition",
    "draining",
  );
  assert.match(original.outboxId, /^[a-f0-9]{64}$/);
  const transmitted = await handoff.dispatchOneLiteraryPreparationHandoff(handoffEnv);
  assert.equal(transmitted.delivered, original.outboxId);

  const prepEnv = {
    ...handoffEnv,
    FORE_CONTENT_PROCESSOR_ROLE: "literary-prepare",
  };
  const prepared = await prep.runIsolatedLiteraryPreparationTick(prepEnv);
  assert.equal(prepared.prepared, original.outboxId);
  const inferEnv = {
    ...handoffEnv,
    FORE_CONTENT_PROCESSOR_ROLE: "literary-infer",
    FORE_CONTENT_INFERENCE_ENABLED: "1",
    FORE_CONTENT_BUDGET_MODE: "isolated",
    AI: {
      async run() {
        aiCalls++;
        assert.equal(
          (
            await DB.prepare(
              "SELECT status FROM literary_profiles WHERE product_id='qa_literary'",
            ).first()
          ).status,
          "provisional",
        );
        return { response: JSON.stringify(emptyLiteraryProfile()) };
      },
    },
  };
  const seeded = await infer.seedOneIsolatedLiteraryInference(inferEnv);
  assert.match(seeded.enqueued, /^[a-f0-9]{64}$/);
  const inferred = await infer.runIsolatedLiteraryInferenceTick(inferEnv);
  assert.equal(inferred.inferred, seeded.enqueued);
  assert.equal(aiCalls, 1);

  // An already computed result must remain unpublished under draining.
  const denied = await infer.publishIsolatedLiteraryInference(
    { ...inferEnv, FORE_LITERARY_INFERENCE_PUBLISH_ENABLED: "1" },
    seeded.enqueued,
  );
  assert.deepEqual(denied, { skipped: "canonical_owner_not_isolated" });
  const heldPrimary = await DB.prepare(
    "SELECT revision,status FROM literary_profiles WHERE product_id='qa_literary'",
  ).first();
  assert.equal(heldPrimary.status, "provisional");

  await DB.prepare(
    "UPDATE cove_runtime_config SET value='isolated' WHERE key='literary_processing_owner'",
  ).run();
  const tokenA = "a".repeat(48);
  const tokenB = "b".repeat(48);
  const publishEnv = {
    ...inferEnv,
    FORE_LITERARY_INFERENCE_PUBLISH_ENABLED: "1",
    FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256: sha(tokenA),
    FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256: sha(tokenB),
  };
  const workerService = {
    fetch(request) {
      return gateway.handleLiteraryPublication(request, publishEnv, undefined, async () => ({
        allowed: true,
        reason: "synthetic_stage",
        probeMs: 1,
      }));
    },
  };
  const autopublish = {
    ...inferEnv,
    FORE_LITERARY_AUTOPUBLISH_ENABLED: "1",
    FORE_LITERARY_INFERENCE_PUBLISH_TOKEN: tokenA,
    FORE_LITERARY_INFERENCE_BACKEND_TOKEN: tokenB,
    LITERARY_PUBLISHER: workerService,
  };
  const publishResult = await publisher.publishOnePrivateLiteraryInference(autopublish);
  assert.equal(publishResult.published, seeded.enqueued);
  const canonical = await DB.prepare(
    "SELECT revision,status,coverage FROM literary_profiles WHERE product_id='qa_literary'",
  ).first();
  assert.deepEqual(canonical, { revision: 1, status: "analyzed", coverage: "isolated_samples" });
  assert.equal(
    (
      await CONTENT_DB.prepare("SELECT publication_state FROM literary_inference_jobs WHERE id=?")
        .bind(seeded.enqueued)
        .first()
    ).publication_state,
    "published",
  );
  assert.deepEqual(await publisher.publishOnePrivateLiteraryInference(autopublish), {
    skipped: "no_completed_inference",
  });
  const evidence = {
    schema: "cove.literary.remote-synthetic-e2e.v1",
    committedSha: process.env.GITHUB_SHA,
    stagingOnly: true,
    productionTouched: false,
    observedAt: new Date().toISOString(),
    databases: [primary, content],
    privateBucket: bucket,
    sourceHash,
    handoffId: original.outboxId,
    inferenceId: seeded.enqueued,
    aiStubbed: true,
    publisherServiceBindingEmulated: true,
    canonicalOwnerDrainDenied: true,
    canonicalRevision: canonical.revision,
    primaryStatus: canonical.status,
    settled: true,
    remoteStatements,
    r2Puts,
  };
  mkdirSync("artifacts/literary-cutover", { recursive: true });
  writeFileSync(
    "artifacts/literary-cutover/remote-synthetic-e2e.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log("LITERARY_REMOTE_STAGING_E2E_PASS", JSON.stringify(evidence));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
