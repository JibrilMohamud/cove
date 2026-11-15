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
const PAGE_TWO_MODE = process.argv.includes("--page-two-only");
const CURSOR_MODE = process.argv.includes("--cursor-only");
const SHADOW_MODE = process.argv.includes("--shadow-no-db");
const EVIDENCE = {
  schema: "cove.synthetic-r2-display-current-retail-rights-100rps.v1",
  releaseCertified: false,
  productionModified: false,
  sourceBranch: SHADOW_MODE
    ? "perf/stage-paired-ingress-control-20261115"
    : CURSOR_MODE
      ? "perf/stage-signed-rights-cursor-20261115"
      : PAGE_TWO_MODE
        ? "perf/stage-page2-hosted-capacity-20261115"
        : "perf/stage-page2-live-rights-20261115",
  originalCandidateVersion: ORIGINAL,
  testedChange:
    "Synthetic-only full public book DTO from short-lived R2; live primary-D1 rights, offers, DRM and asset state + same-statement metadata generation fence; publication trigger coverage remains stage-only",
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

async function assertRemoteSyntheticMetadataFence() {
  // A local SQLite fixture pass cannot prove that the REAL isolated D1
  // contains the triggers. Refuse to deploy or score 100-RPS until it does.
  // This is a SELECT against the pinned synthetic D1, not production D1.
  const query = await api("/d1/database/" + DB + "/query", {
    method: "POST",
    body: JSON.stringify({
      sql: "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'cove_syn_metadata_%' ORDER BY name",
    }),
  });
  const names = query?.[0]?.results?.map((row) => row.name);
  assert.ok(Array.isArray(names), "Synthetic D1 trigger audit was not returned");
  assert.equal(names.length, 18, "Remote synthetic D1 needs all 18 freshness triggers");
  for (const name of [
    "cove_syn_metadata_product_insert",
    "cove_syn_metadata_product_delete",
    "cove_syn_metadata_product_source_update",
  ])
    assert.ok(names.includes(name), "Missing synthetic source-binding trigger: " + name);
  EVIDENCE.remoteSyntheticRevisionTriggerCount = names.length;
  EVIDENCE.remoteSyntheticSourceBindingTriggersVerified = true;
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
    assert.ok(names.includes("FORE_GUEST_CONTEXT_R2_STAGE"));
    assert.ok(names.includes("COVE_SYNTHETIC_STAGING_ONLY"));
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
            "Rollback synthetic R2 market-context experiment to pinned stage candidate",
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

async function deployArm() {
  assertOriginal(await activeCandidate());
  const form = new FormData();
  const bindings = [
    ...EXPECTED_BINDINGS.map((name) => ({ name, type: "inherit" })),
    { name: "FORE_GUEST_COMPACT_STAGE", type: "plain_text", text: "1" },
    { name: "FORE_GUEST_CONTEXT_R2_STAGE", type: "plain_text", text: "0" },
    { name: "FORE_GUEST_R2_DISPLAY_STAGE", type: "plain_text", text: "1" },
    { name: "FORE_GUEST_COMPACT_SYNTHETIC_D1_ID", type: "plain_text", text: DB },
    { name: "COVE_SYNTHETIC_STAGING_ONLY", type: "plain_text", text: DB },
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
  assert.equal(state.bindings.length, EXPECTED_BINDINGS.length + 5);
  assert.equal(state.bindings.find((b) => b.name === "FORE_GUEST_COMPACT_STAGE")?.text, "1");
  assert.equal(state.bindings.find((b) => b.name === "FORE_GUEST_CONTEXT_R2_STAGE")?.text, "0");
  assert.equal(state.bindings.find((b) => b.name === "FORE_GUEST_R2_DISPLAY_STAGE")?.text, "1");
  assert.equal(state.bindings.find((b) => b.name === "COVE_SYNTHETIC_STAGING_ONLY")?.text, DB);
  assert.equal(state.runtime?.limits?.cpu_ms, 300000);
  EVIDENCE.variant.push({
    mode: "r2-live-retail",
    version: state.version,
    at: new Date().toISOString(),
  });
  return state.version;
}

function loadEvidence() {
  const path = join("artifacts", "causal-triad-stage", "controlled-worker-runs.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function runArm(name, candidateMode = "r2live") {
  const runner = "scripts/staging/run-private-causal-triad.mjs";
  const start = Date.now();
  const flag =
    candidateMode === "r2cursor"
      ? "--r2-cursor-100rps"
      : candidateMode === "r2page2"
        ? "--r2-page2-100rps"
        : "--r2-retail-100rps";
  if (SHADOW_MODE && candidateMode !== "r2cursor")
    throw Error("Concurrent shadow must test the real cursor candidate");
  const result = spawnSync(
    process.execPath,
    [runner, flag, ...(SHADOW_MODE ? ["--shadow-no-db"] : [])],
    {
      cwd: ".",
      env: { ...process.env, COVE_ALLOW_SAFE_RESTORE: "1" },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 8 * 60 * 1000,
    },
  );
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
        arm: name,
        exitStatus: result.status,
        signal: result.signal || null,
        category,
      }),
    );
    throw new Error("Stage driver failed before trustworthy evidence; cause=" + category);
  }
  assert.equal(raw.restoredOriginal, true, "Stage driver rollback must succeed");
  const target = raw.results.find((r) => r.mode === candidateMode && r.shape === "50-rps-20s");
  assert.ok(target, "The sustained 50-RPS phase did not execute in " + name);
  assert.equal(target.offered, 1000, "Exact offered workload required");
  assert.equal(target.dropped, 0, "No hidden generator drops allowed");
  assert.equal(target.valid + target.failed, 1000);
  EVIDENCE.fixtureOfferWitness = raw.syntheticLiveOfferWitnessCount;
  EVIDENCE.fixtureOfferParity = raw.syntheticRetailOfferParityProved === true;
  const concise = {
    name,
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
    tailAttribution: target.tailAttribution || null,
    statusCounts: target.statusCounts,
    // The private diagnostic never reports raw book IDs, headers, SQL or
    // exception messages. These low-cardinality classifications distinguish
    // real candidate 503s from invalid synthetic 200 payloads.
    downstreamStatusCounts: target.downstreamStatusCounts || {},
    failureKindCounts: target.failureKindCounts || {},
    invalidUpstream200: target.invalidUpstream200 || 0,
  };
  concise.catalogPhases = raw.results
    .filter((x) => x.mode === candidateMode && x.shape.includes("rps"))
    .map((x) => ({
      shape: x.shape,
      offered: x.offered,
      valid: x.valid,
      failed: x.failed,
      dropped: x.dropped,
      p95: x.ttfbP95Ms,
      p99: x.ttfbP99Ms,
      max: x.ttfbMaxMs,
      tailAttribution: x.tailAttribution || null,
      statusCounts: x.statusCounts || {},
      failureKindCounts: x.failureKindCounts || {},
      downstreamStatusCounts: x.downstreamStatusCounts || {},
      ingressShadow: x.ingressShadow || null,
    }));
  const strict = (x, offered) =>
    x &&
    x.offered === offered &&
    x.valid === offered &&
    x.dropped === 0 &&
    x.ttfbP95Ms !== null &&
    x.ttfbP95Ms < 600 &&
    x.ttfbP99Ms < 750 &&
    x.ttfbMaxMs < 800 &&
    (!SHADOW_MODE || offered !== 2000 || x.ingressShadow?.passed === true);
  const fifty = raw.results.find((x) => x.mode === candidateMode && x.shape === "50-rps-20s");
  const phase1 = raw.results.find(
    (x) => x.mode === candidateMode && x.shape === "100-rps-20s-phase-1",
  );
  const phase2 = raw.results.find(
    (x) => x.mode === candidateMode && x.shape === "100-rps-20s-phase-2",
  );
  const passed =
    result.status === 0 &&
    raw.restoredOriginal === true &&
    (candidateMode === "r2cursor"
      ? raw.r2Cursor100RpsPassed
      : candidateMode === "r2page2"
        ? raw.r2Page2100RpsPassed
        : raw.r2Retail100RpsPassed) === true &&
    strict(fifty, 1000) &&
    strict(phase1, 2000) &&
    strict(phase2, 2000);
  if (candidateMode === "r2cursor") concise.r2CursorTwoPhasePassed = passed;
  else if (candidateMode === "r2page2") concise.r2Page2TwoPhasePassed = passed;
  else concise.r2FullSyntheticTwoPhasePassed = passed;
  console.log(
    JSON.stringify({
      event:
        candidateMode === "r2cursor"
          ? "cove_signed_cursor_current_rights_stage"
          : candidateMode === "r2page2"
            ? "cove_r2_page_two_current_rights_stage"
            : "cove_r2_retail_current_rights_stage",
      ...concise,
    }),
  );
  if (!passed)
    throw Error("Isolated R2 live retail strict two-phase 100-RPS gate failed; no release");
  return concise;
}

function save() {
  mkdirSync("artifacts/public-context-r2-ab", { recursive: true });
  writeFileSync(
    "artifacts/public-context-r2-ab/results.json",
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
    await assertRemoteSyntheticMetadataFence();
    // Only the isolated non-routable candidate and pinned private driver.
    // Real production catalog/owner/payment paths are unchanged.
    await deployArm();
    armed = true;
    if (CURSOR_MODE) {
      EVIDENCE.cursor = runArm("r2-signed-cursor-live-retail", "r2cursor");
      EVIDENCE.syntheticStrict100RpsPassed = EVIDENCE.cursor.r2CursorTwoPhasePassed;
    } else if (PAGE_TWO_MODE) {
      EVIDENCE.page2 = runArm("r2-display-live-retail-page-two", "r2page2");
      EVIDENCE.syntheticStrict100RpsPassed = EVIDENCE.page2.r2Page2TwoPhasePassed;
    } else {
      EVIDENCE.r2 = runArm("r2-display-live-retail");
      EVIDENCE.syntheticStrict100RpsPassed = EVIDENCE.r2.r2FullSyntheticTwoPhasePassed;
    }
    EVIDENCE.completed = true;
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
      "Synthetic R2 live-retail capacity proof blocked:",
      error instanceof Error ? error.message : "unknown",
    );
    process.exitCode = 1;
  });
