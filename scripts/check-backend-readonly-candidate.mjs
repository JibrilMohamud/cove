import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const config = readFileSync("wrangler.backend.readonly-candidate.toml", "utf8");
const backend = readFileSync("src/persistence-backend.worker.ts", "utf8");

assert.match(config, /name = "cove-persistence-backend-readonly-candidate"/);
assert.match(config, /workers_dev = false/);
assert.match(config, /preview_urls = false/);
assert.match(config, /routes = \[\]/);
assert.match(config, /binding = "COVE_CANONICAL_READONLY"/);
assert.match(config, /service = "cove-canonical-d1-readonly"/);
assert.match(config, /COVE_BACKEND_READONLY_CANDIDATE = "1"/);
assert.match(config, /COVE_BACKEND_TOKEN_HASH_ONLY = "1"/);
assert.match(config, /COVE_CANONICAL_READONLY_RPC = "1"/);
assert.doesNotMatch(
  config,
  /\[\[d1_databases\]\]|\[triggers\]|\bcrons\s*=|\bFORE_BACKEND_TOKEN_SHA256\s*=/,
);
assert.match(backend, /scopeBackendReadonlyCandidate\(env\)/);
assert.match(backend, /verifyIndependentBackendCredential\(request, env\)/);
assert.match(backend, /if \(env.COVE_BACKEND_TOKEN_HASH_ONLY !== undefined\)/);
assert.match(backend, /backendReadonlyCandidateRouteAllowed\(request\)/);
assert.match(backend, /private_backend_readonly_candidate_cron_denied/);
assert.match(backend, /backendScheduledPrimaryReadDb\(env\)/);
assert.match(backend, /COVE_BACKEND_SCHEDULED_READONLY_RPC\?: string/);
assert.equal(
  (backend.match(/const db = backendScheduledPrimaryReadDb\(env\);/g) || []).length,
  5,
  "All five scheduled query scopes must use the independent primary reader",
);
assert.match(backend, /const firstMapPending = await db\.prepare\(/);
assert.match(backend, /const schedulerOwnerDb = backendScheduledPrimaryReadDb\(env\);/);
assert.equal(
  (backend.match(/contentPipelineOwner\(schedulerOwnerDb,/g) || []).length,
  2,
  "Both scheduler ownership predicates must use the independent D1 Read service",
);
assert.equal(
  (backend.match(/admitCatalogBatch\(\s*backendScheduledPrimaryReadDb\(env\)/g) || [])
    .length,
  3,
  "All three guarded background admission probes must use the independent reader",
);

const folder = mkdtempSync(path.join(tmpdir(), "cove-backend-readonly-"));
try {
  const outfile = path.join(folder, "candidate.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/backend-readonly-candidate.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
  });
  const { scopeBackendReadonlyCandidate, backendReadonlyCandidateRouteAllowed } = await import(
    pathToFileURL(outfile).href
  );
  const queries = [];
  let outage = false;
  const service = {
    async query(statements) {
      queries.push(statements);
      if (outage) throw Error("provider_unavailable");
      assert.ok(statements.every((s) => /^SELECT\b/i.test(s.sql)));
      return statements.map(() => ({
        success: true,
        results: [{ ok: 1 }],
        meta: { served_by_primary: true },
      }));
    },
  };
  const fixture = {
    COVE_BACKEND_READONLY_CANDIDATE: "1",
    COVE_BACKEND_TOKEN_HASH_ONLY: "1",
    COVE_CANONICAL_READONLY_RPC: "1",
    COVE_CANONICAL_READONLY: service,
    FORE_ENVIRONMENT: "staging",
    FORE_BACKEND_TOKEN_SHA256: "a".repeat(64),
  };
  const candidate = scopeBackendReadonlyCandidate(fixture);
  assert.equal(typeof candidate.DB.prepare, "function");
  assert.equal((await candidate.DB.prepare("SELECT 1 ok").first()).ok, 1);
  await assert.rejects(
    () => candidate.DB.prepare("UPDATE entitlements SET status='active'").run(),
    /read-only/,
  );
  await assert.rejects(() => candidate.DB.prepare("DELETE FROM entitlements").all());
  assert.equal(queries.length, 2);
  outage = true;
  await assert.rejects(() => candidate.DB.prepare("SELECT 1 ok").all(), /provider_unavailable/);
  const readable = [
    "https://private.invalid/__cove/health",
    "https://private.invalid/api/fore/health/ready",
  ];
  for (const url of readable)
    assert.equal(backendReadonlyCandidateRouteAllowed(new Request(url)), true);
  for (const url of [
    "https://private.invalid/api/fore/stripe/webhook",
    "https://private.invalid/api/fore/entitlements",
    "https://private.invalid/api/fore/health/ready?inspect=1",
    "https://private.invalid/__cove/ingestion/catalog",
    "https://private.invalid/api/fore/health/live",
  ])
    assert.equal(backendReadonlyCandidateRouteAllowed(new Request(url)), false);
  assert.equal(
    backendReadonlyCandidateRouteAllowed(
      new Request("https://private.invalid/__cove/health", { method: "POST" }),
    ),
    false,
  );
  for (const mutation of [
    { DB: { prepare() {} } },
    { COVE_CANONICAL_READONLY_RPC: "0" },
    { COVE_CANONICAL_READONLY: undefined },
    { FORE_ENVIRONMENT: "production" },
    { FORE_BACKEND_TOKEN_SHA256: "" },
    { COVE_BACKEND_READONLY_CANDIDATE: "0" },
    { COVE_BACKEND_TOKEN_HASH_ONLY: "0" },
    { FORE_BACKEND_TOKEN: "bad-plaintext-legacy-credential" },
  ])
    assert.throws(
      () => scopeBackendReadonlyCandidate({ ...fixture, ...mutation }),
      /not_certified/,
    );
  const independentFile = path.join(folder, "independent-auth.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/backend-independent-credential.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: independentFile,
  });
  const { verifyIndependentBackendCredential } = await import(pathToFileURL(independentFile).href);
  const standaloneToken = "separate-private-cove-token-" + "p".repeat(48);
  const standaloneHash = createHash("sha256").update(standaloneToken).digest("hex");
  const independentConfig = {
    COVE_BACKEND_TOKEN_HASH_ONLY: "1",
    FORE_BACKEND_TOKEN_SHA256: standaloneHash,
  };
  const authRequest = (token) =>
    new Request("https://private.invalid/__cove/health", {
      headers: { "x-cove-backend-token": token },
    });
  const forbiddenDb = {
    prepare() {
      throw Error("D1_READ_FORBIDDEN");
    },
  };
  const verified = await verifyIndependentBackendCredential(authRequest(standaloneToken), {
    ...independentConfig,
    DB: forbiddenDb,
  });
  assert.equal(verified, true, "Independent credential must not access the primary D1");
  for (const bad of [
    { COVE_BACKEND_TOKEN_HASH_ONLY: "0" },
    { COVE_BACKEND_TOKEN_HASH_ONLY: undefined },
    { FORE_BACKEND_TOKEN_SHA256: "" },
    { FORE_BACKEND_TOKEN_SHA256: "g".repeat(64) },
    { FORE_BACKEND_TOKEN: standaloneToken },
  ]) {
    const denied = await verifyIndependentBackendCredential(authRequest(standaloneToken), {
      ...independentConfig,
      ...bad,
    });
    assert.equal(denied, false, "Misconfigured hash-only auth must deny without fallback");
  }
  for (const supplied of ["", "short", standaloneToken + "wrong", "x".repeat(513)]) {
    const denied = await verifyIndependentBackendCredential(
      authRequest(supplied),
      independentConfig,
    );
    assert.equal(denied, false);
  }
  const readonlyFile = path.join(folder, "scheduled.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/backend-scheduled-primary-reads.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: readonlyFile,
  });
  const { backendScheduledPrimaryReadDb } = await import(pathToFileURL(readonlyFile).href);
  let privilegedReadCalls = 0;
  const privileged = {
    prepare() {
      privilegedReadCalls++;
      throw Error("privileged_D1_must_not_be_used");
    },
  };
  const restricted = backendScheduledPrimaryReadDb({
    DB: privileged,
    COVE_BACKEND_SCHEDULED_READONLY_RPC: "1",
    COVE_CANONICAL_READONLY_RPC: "1",
    COVE_CANONICAL_READONLY: service,
  });
  outage = false;
  assert.equal((await restricted.prepare("SELECT ? as ok").bind(10).first()).ok, 1);
  await assert.rejects(() => restricted.prepare("DELETE FROM audio_jobs").run(), /read-only/);
  assert.equal(privilegedReadCalls, 0);
  outage = true;
  await assert.rejects(
    () => restricted.prepare("SELECT 1").all(),
    /provider_unavailable/,
    "A failed provider must not retry through native D1",
  );
  assert.equal(privilegedReadCalls, 0);
  for (const bad of [
    { COVE_BACKEND_SCHEDULED_READONLY_RPC: "0" },
    { COVE_BACKEND_SCHEDULED_READONLY_RPC: "1", COVE_CANONICAL_READONLY_RPC: "0" },
    { COVE_BACKEND_SCHEDULED_READONLY_RPC: "1", COVE_CANONICAL_READONLY: undefined },
    { COVE_BACKEND_SCHEDULED_READONLY_RPC: "garbage" },
  ])
    assert.throws(
      () => backendScheduledPrimaryReadDb({ DB: privileged, ...bad }),
      /scheduled_primary_read_owner_unavailable/,
    );
  assert.equal(backendScheduledPrimaryReadDb({ DB: privileged }), privileged);
  const controlOwnerFile = path.join(folder, "content-owner.mjs");
  const admissionFile = path.join(folder, "catalog-admission.mjs");
  await build({
    entryPoints: ["src/lib/content-processing-owner.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: controlOwnerFile,
  });
  await build({
    entryPoints: ["src/lib/catalog-ingestion-backpressure.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: admissionFile,
  });
  const { contentPipelineOwner } = await import(pathToFileURL(controlOwnerFile).href);
  const { admitCatalogBatch } = await import(pathToFileURL(admissionFile).href);
  outage = false;
  const beforeControls = queries.length;
  assert.equal(await contentPipelineOwner(restricted, "assets"), "legacy");
  assert.equal(await contentPipelineOwner(restricted, "literary"), "legacy");
  assert.match(queries.at(-1)[0].sql, /cove_runtime_config/);
  const admission = await admitCatalogBatch(restricted, 1000);
  assert.equal(admission.allowed, true);
  assert.equal(queries.length, beforeControls + 3);
  assert.equal(privilegedReadCalls, 0);
  outage = true;
  await assert.rejects(
    () => contentPipelineOwner(restricted, "assets"),
    /provider_unavailable/,
    "An unavailable primary reader must not activate legacy scheduler ownership",
  );
  const deniedAdmission = await admitCatalogBatch(restricted, 1000);
  assert.deepEqual(
    { allowed: deniedAdmission.allowed, reason: deniedAdmission.reason },
    { allowed: false, reason: "primary_unavailable" },
  );
  assert.equal(privilegedReadCalls, 0, "Provider outages cannot fall back to native D1");
  const unchanged = { DB: { prepare() {} } };
  assert.equal(scopeBackendReadonlyCandidate(unchanged), unchanged);
  console.log(
    "PASS: private health-only backend canary cannot access native D1, serve writes or use a replica/failed read.",
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
