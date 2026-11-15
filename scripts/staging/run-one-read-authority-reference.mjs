import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const SCRIPT = "cove-presentation-r2-candidate-stage";
const ORIGINAL = "60d1924f-2917-42be-acf7-496e84cb55e7";
const DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const CACHE_BUCKET = "cove-public-presentation-stage-20261114";
const ROOT = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT;
const EXPECTED_BINDINGS = [
  "COVE_OPS_TELEMETRY_MODE",
  "COVE_PUBLIC_ANON_HTTP_TELEMETRY",
  "COVE_PUBLIC_PRESENTATION_CACHE",
  "COVE_STOREFRONT_READ_LIMITER",
  "DB",
  "FORE_ASYNC_CATALOG_FACETS",
  "FORE_AUDIO_COMPUTE_MODE",
  "FORE_BACKEND_TOKEN",
  "FORE_CATALOG_EPUBS_PER_TICK",
  "FORE_DEFAULT_TERRITORY",
  "FORE_ENVIRONMENT",
  "FORE_GUEST_CATALOG_PROGRESSIVE_COUNT",
  "FORE_POPULAR_RIGHTS_SHORTLIST",
  "FORE_PUBLIC_URL",
  "FORE_SEARCH_BACKEND",
  "OPS_ANALYTICS",
].sort();
const EVIDENCE = {
  schema: "cove.synthetic-single-current-rights-reference.v1",
  releaseCertified: false,
  productionModified: false,
  sourceBranch: "perf/stage-single-authority-catalog-20261114",
  originalCandidateVersion: ORIGINAL,
  syntheticD1: DB,
  variant: [],
};

const apiToken = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
assert.ok(apiToken && apiToken.length > 20, "Explicit staging deployment token required");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(ROOT + path, {
    method,
    headers: {
      authorization: "Bearer " + apiToken,
      accept: "application/json",
      ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
    },
    body,
    signal: AbortSignal.timeout(45000),
  });
  const envelope = await response.json();
  if (!response.ok || !envelope.success)
    throw new Error(
      "Cloudflare API " +
        method +
        " " +
        path.split("?")[0] +
        " returned " +
        response.status +
        " (" +
        (envelope.errors || []).map((x) => x.code).join(",") +
        ")",
    );
  return envelope.result;
}

async function activeCandidate() {
  const [deployments, ingress, cron] = await Promise.all([
    api("/workers/scripts/" + SCRIPT + "/deployments"),
    api("/workers/scripts/" + SCRIPT + "/subdomain"),
    api("/workers/scripts/" + SCRIPT + "/schedules"),
  ]);
  const version = deployments.deployments?.[0]?.versions?.[0]?.version_id;
  assert.ok(version, "Candidate must have one deployed version");
  const details = await api("/workers/scripts/" + SCRIPT + "/versions/" + version);
  return {
    version,
    ingress,
    cron: cron.schedules || [],
    bindings: details.resources?.bindings || [],
    runtime: details.resources?.script_runtime,
  };
}

function assertIsolated(state) {
  assert.equal(state.ingress.enabled, false, "Candidate must not have workers.dev ingress");
  assert.equal(state.ingress.previews_enabled, false, "Candidate previews must be disabled");
  assert.equal(state.cron.length, 0, "Candidate must have zero cron triggers");
  const db = state.bindings.filter((b) => b.type === "d1");
  assert.equal(db.length, 1, "Only one D1 binding allowed in the experiment");
  assert.equal(db[0].database_id, DB, "Production D1 must never be attached");
  assert.deepEqual(
    state.bindings
      .filter((b) => b.name === "COVE_PUBLIC_PRESENTATION_CACHE")
      .map((b) => b.bucket_name),
    [CACHE_BUCKET],
  );
  const unsafe = state.bindings.filter((b) =>
    /LEGAL_AUTHORITY|PAYMENT|STRIPE|OWNER|PRODUCTION_MEDIA/i.test(b.name),
  );
  assert.deepEqual(unsafe, [], "Never inherit production owner or commerce bindings");
}

function assertOriginal(state) {
  assertIsolated(state);
  assert.equal(state.version, ORIGINAL, "Concurrently modified candidate; refusing deployment");
  assert.deepEqual(state.bindings.map((b) => b.name).sort(), EXPECTED_BINDINGS);
  assert.equal(state.runtime?.limits?.cpu_ms, 300000);
}

async function rollback() {
  const current = await activeCandidate();
  if (current.version !== ORIGINAL) {
    assertIsolated(current);
    const names = current.bindings.map((b) => b.name);
    assert.ok(names.includes("FORE_GUEST_COMPACT_STAGE"));
    assert.equal(
      current.bindings.find((b) => b.name === "FORE_GUEST_COMPACT_SYNTHETIC_D1_ID")?.text,
      DB,
      "Only exact synthetic D1 staging fixture is eligible for rollback",
    );
    await api("/workers/scripts/" + SCRIPT + "/deployments", {
      method: "POST",
      body: JSON.stringify({
        strategy: "percentage",
        versions: [{ version_id: ORIGINAL, percentage: 100 }],
        annotations: {
          "workers/message":
            "Rollback single-primary-read experiment to exact original stage candidate",
        },
      }),
    });
    // Cloudflare may acknowledge a deployment before version reads converge.
    // Only the pinned original or our known diagnostic version is acceptable.
    for (let attempt = 0; attempt < 12; attempt++) {
      const state = await activeCandidate();
      if (state.version === ORIGINAL) {
        assertOriginal(state);
        return true;
      }
      if (state.version !== current.version)
        throw new Error("Unexpected third-party candidate deployment during rollback");
      await sleep(500);
    }
    throw new Error("Pinned candidate rollback was not verified after bounded polls");
  }
  assertOriginal(await activeCandidate());
  return true;
}

async function deployArm(enabled) {
  assertOriginal(await activeCandidate());
  const form = new FormData();
  const bindings = [
    ...EXPECTED_BINDINGS.map((name) => ({ name, type: "inherit" })),
    { name: "FORE_GUEST_COMPACT_STAGE", type: "plain_text", text: enabled ? "1" : "0" },
    { name: "FORE_GUEST_COMPACT_SYNTHETIC_D1_ID", type: "plain_text", text: DB },
  ];
  const metadata = {
    main_module: "candidate.mjs",
    compatibility_date: "2026-10-09",
    limits: { cpu_ms: 300000 },
    bindings,
    observability: {
      enabled: true,
      redact_query_string: true,
      logs: { enabled: true, head_sampling_rate: 1, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.1, persist: true },
    },
  };
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(
    "candidate.mjs",
    new Blob([readFileSync("backend-dist/worker.js")], {
      type: "application/javascript+module",
    }),
    "candidate.mjs",
  );
  await api("/workers/scripts/" + SCRIPT + "?bindings_inherit=strict", {
    method: "PUT",
    body: form,
  });
  const state = await activeCandidate();
  assertIsolated(state);
  assert.notEqual(state.version, ORIGINAL);
  assert.equal(state.bindings.length, EXPECTED_BINDINGS.length + 2);
  assert.equal(
    state.bindings.find((b) => b.name === "FORE_GUEST_COMPACT_STAGE")?.text,
    enabled ? "1" : "0",
  );
  assert.equal(state.runtime?.limits?.cpu_ms, 300000);
  EVIDENCE.variant.push({
    mode: enabled ? "compact" : "baseline",
    version: state.version,
    at: new Date().toISOString(),
  });
  return state.version;
}

function loadEvidence() {
  const path = join(
    "stage-driver",
    "artifacts",
    "causal-triad-stage",
    "controlled-worker-runs.json",
  );
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function runReference() {
  const runner = "scripts/staging/run-private-causal-triad.mjs";
  const start = Date.now();
  const result = spawnSync(process.execPath, [runner, "--single-only"], {
    cwd: "stage-driver",
    env: { ...process.env, COVE_ALLOW_SAFE_RESTORE: "1" },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8 * 60 * 1000,
  });
  const raw = loadEvidence();
  if (!raw) {
    const logs = String(result.stderr || "") + String(result.stdout || "");
    const category = logs.includes("Concurrent modification")
      ? "stage-version-conflict"
      : logs.includes("Private staging route did not propagate")
        ? "stage-ingress-propagation"
        : logs.includes("Unexpected third-party stage deployment")
          ? "stage-rollback-version-guard"
          : logs.includes("Cloudflare ")
            ? "cloudflare-api-error"
            : logs.includes("Stage test failed")
              ? "stage-validity-gate"
              : logs.includes("No stage")
                ? "stage-preflight"
                : "stage-process-without-evidence";
    console.warn(
      JSON.stringify({
        event: "cove_stage_driver_no_evidence",
        arm: "single-primary-reference",
        exitStatus: result.status,
        signal: result.signal || null,
        category,
      }),
    );
    throw new Error("Stage driver failed before trustworthy evidence; cause=" + category);
  }
  assert.equal(raw.restoredOriginal, true, "Stage driver rollback must succeed");
  const target = raw.results.find((r) => r.mode === "single" && r.shape === "50-rps-20s");
  assert.ok(target, "The sustained 50-RPS reference phase did not execute");
  assert.equal(target.offered, 1000, "Exact offered workload required");
  assert.equal(target.dropped, 0, "No hidden generator drops allowed");
  assert.equal(target.valid + target.failed, 1000);
  const concise = {
    name: "single-primary-reference",
    runnerExitStatus: result.status,
    testDurationMs: Date.now() - start,
    offered: target.offered,
    valid: target.valid,
    failed: target.failed,
    dropped: target.dropped,
    achievedRps: target.achievedRps,
    ttfbP95Ms: target.ttfbP95Ms,
    ttfbP99Ms: target.ttfbP99Ms,
    ttfbMaxMs: target.ttfbMaxMs,
    workerP95Ms: target.workerP95Ms,
    statusCounts: target.statusCounts,
    // The private diagnostic never reports raw book IDs, headers, SQL or
    // exception messages. These low-cardinality classifications distinguish
    // real candidate 503s from invalid synthetic 200 payloads.
    downstreamStatusCounts: target.downstreamStatusCounts || {},
    failureKindCounts: target.failureKindCounts || {},
    invalidUpstream200: target.invalidUpstream200 || 0,
  };
  concise.catalogPhases = raw.results
    .filter((x) => x.mode === "single" && x.shape.includes("rps"))
    .map((x) => ({
      shape: x.shape,
      offered: x.offered,
      valid: x.valid,
      failed: x.failed,
      dropped: x.dropped,
      p95: x.ttfbP95Ms,
      p99: x.ttfbP99Ms,
      max: x.ttfbMaxMs,
    }));
  console.log(JSON.stringify({ event: "cove_single_primary_d1_reference", ...concise }));
  return concise;
}

function save() {
  mkdirSync("artifacts/single-primary-reference", { recursive: true });
  writeFileSync(
    "artifacts/single-primary-reference/results.json",
    JSON.stringify(EVIDENCE, null, 2) + "\n",
  );
}

async function main() {
  if (process.argv.includes("--restore-only")) {
    console.log(JSON.stringify({ event: "cove_candidate_restored", safe: await rollback() }));
    return;
  }
  let armed = false;
  try {
    assertOriginal(await activeCandidate());
    EVIDENCE.originalConfirmed = true;
    EVIDENCE.beganAt = new Date().toISOString();
    // This never returns a usable storefront response. Only the real full
    // canonical projection + current territorial retail rights are measured.
    // The market/context pipeline remains unaltered on all real routes.
    await deployArm(true);
    armed = true;
    EVIDENCE.reference = runReference();
    EVIDENCE.completed = true;
    EVIDENCE.reference50Passed =
      EVIDENCE.reference.valid === 1000 &&
      EVIDENCE.reference.dropped === 0 &&
      EVIDENCE.reference.ttfbP95Ms < 600 &&
      EVIDENCE.reference.ttfbP99Ms < 750 &&
      EVIDENCE.reference.ttfbMaxMs < 800;
    // The enclosed driver separately guards escalation to 100 RPS.
    EVIDENCE.referenceCouldReach100Rps = EVIDENCE.reference50Passed;
  } catch (error) {
    EVIDENCE.completed = false;
    EVIDENCE.failureKind = error instanceof Error ? error.message.slice(0, 230) : "unknown";
    throw error;
  } finally {
    try {
      if (armed || process.env.COVE_ALLOW_SAFE_RESTORE === "1")
        EVIDENCE.candidateRestored = await rollback();
    } finally {
      EVIDENCE.endedAt = new Date().toISOString();
      save();
    }
  }
}

if (import.meta.url === new URL("file://" + process.argv[1]).href)
  main().catch((error) => {
    console.error(
      "Synthetic one-D1 reference blocked:",
      error instanceof Error ? error.message : "unknown",
    );
    process.exitCode = 1;
  });
