import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const SCRIPT = "cove-presentation-capacity-driver-stage";
const OLD_VERSION = "4c25df92-5f4d-4b57-ac8c-c7b80d8a34c2";
const DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const SERVICE = "cove-presentation-r2-candidate-stage";
const ORIGIN = "https://cove-presentation-capacity-driver-stage.cove-jibrilmohamud.workers.dev";
const PREFIX = "/__cove/performance/triad/";
const MODES = ["noop", "context", "rights", "catalog"];
const STOP_AFTER_FAILURES = 1;
const MAX_OUTSTANDING = 64;
const apiRoot = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT;
const evidence = {
  schema: "cove.private-four-path-causal-stage.v1",
  releaseCertified: false,
  fixture: "synthetic-only",
  productionModified: false,
  cloudflareWorker: SCRIPT,
  expectedOriginalVersion: OLD_VERSION,
  results: [],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
};
const rounded = (n) => (Number.isFinite(n) ? Number(n.toFixed(2)) : null);

async function api(path, { method = "GET", body } = {}) {
  assert.ok(ACCOUNT && CF_TOKEN, "Cloudflare account and deployment token required");
  const res = await fetch(apiRoot + path, {
    method,
    headers: { authorization: "Bearer " + CF_TOKEN, accept: "application/json" },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (!res.ok || !json.success)
    throw new Error("Cloudflare " + method + " " + path.split("?")[0] + " failed HTTP " + res.status +
      ": " + (json.errors || []).map((e) => e.code).join(","));
  return json.result;
}

async function scriptState() {
  const [d, sc, ingress] = await Promise.all([
    api("/workers/scripts/" + SCRIPT + "/deployments"),
    api("/workers/scripts/" + SCRIPT + "/schedules"),
    api("/workers/scripts/" + SCRIPT + "/subdomain"),
  ]);
  const version = d.deployments?.[0]?.versions?.[0]?.version_id;
  const details = version
    ? await api("/workers/scripts/" + SCRIPT + "/versions/" + version)
    : null;
  return {
    version,
    bindings: details?.resources?.bindings || [],
    cronCount: (sc.schedules || []).length,
    ingress: Boolean(ingress.enabled),
    previews: Boolean(ingress.previews_enabled),
  };
}

function assertOriginal(state) {
  assert.equal(state.version, OLD_VERSION, "Concurrent modification of stage driver");
  assert.deepEqual(
    state.bindings.map((x) => x.name).sort(),
    ["BACKEND", "CANDIDATE", "GATE"],
    "Original driver must have precisely 3 resources and zero D1",
  );
  assert.equal(state.cronCount, 0, "Do not run alongside a scheduled job");
  assert.equal(state.ingress, true, "Preserve original public ingress setting");
  assert.equal(state.previews, false, "Private preview URLs must stay disabled");
}

async function rollbackIfDiagnostic() {
  const state = await scriptState();
  if (state.version === OLD_VERSION) {
    assertOriginal(state);
    return true;
  }
  const names = new Set(state.bindings.map((x) => x.name));
  const dbs = state.bindings.filter((x) => x.type === "d1");
  if (
    !names.has("COVE_TRIAD_ONDEMAND") ||
    !names.has("COVE_TRIAD_PROBE_GATE") ||
    dbs.length !== 1 ||
    dbs[0].database_id !== DB
  )
    throw new Error("Unexpected third-party stage deployment; refuse unsafe rollback");
  await api("/workers/scripts/" + SCRIPT + "/deployments", {
    method: "POST",
    body: JSON.stringify({
      strategy: "percentage",
      versions: [{ version_id: OLD_VERSION, percentage: 100 }],
      annotations: {
        "workers/message": "Restore pinned original capacity driver after isolated synthetic performance test",
      },
    }),
  });
  assertOriginal(await scriptState());
  return true;
}

async function deployPrivateStage(secret) {
  assertOriginal(await scriptState());
  const modules = [
    ["private-causal-triad.worker.mjs", "scripts/staging/private-causal-triad.worker.mjs"],
    ["causal-triad-stage.worker.mjs", "scripts/staging/causal-triad-stage.worker.mjs"],
  ];
  const expiration = new Date(Date.now() + 15 * 60000).toISOString();
  const metadata = {
    main_module: modules[0][0],
    compatibility_date: "2026-11-14",
    bindings: [
      { name: "BACKEND", type: "inherit" },
      { name: "GATE", type: "inherit" },
      { name: "CANDIDATE", type: "inherit" },
      { name: "DB", type: "d1", database_id: DB },
      { name: "COVE_TRIAD_STAGE", type: "plain_text", text: "1" },
      { name: "COVE_TRIAD_ONDEMAND", type: "plain_text", text: "1" },
      { name: "COVE_TRIAD_SYNTHETIC_D1_ID", type: "plain_text", text: DB },
      { name: "COVE_TRIAD_CANDIDATE", type: "plain_text", text: SERVICE },
      { name: "COVE_TRIAD_EXPIRES_AT", type: "plain_text", text: expiration },
      { name: "COVE_TRIAD_PROBE_GATE", type: "secret_text", text: secret },
    ],
    observability: {
      enabled: true,
      redact_query_string: true,
      logs: { enabled: true, head_sampling_rate: 1, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.1, persist: true },
    },
  };
  const data = new FormData();
  data.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const [filename, file] of modules)
    data.append(filename, new Blob([readFileSync(file)], { type: "application/javascript+module" }), filename);
  const result = await api("/workers/scripts/" + SCRIPT + "?bindings_inherit=strict", {
    method: "PUT",
    body: data,
  });
  const after = await scriptState();
  assert.notEqual(after.version, OLD_VERSION, "Diagnostic version was not activated");
  assert.equal(after.cronCount, 0);
  assert.equal(after.ingress, true);
  assert.equal(after.previews, false);
  const db = after.bindings.filter((x) => x.type === "d1");
  assert.equal(db.length, 1);
  assert.equal(db[0].database_id, DB);
  assert.ok(after.bindings.some((x) => x.name === "COVE_TRIAD_PROBE_GATE" && x.type === "secret_text"));
  assert.ok(after.bindings.some((x) => x.name === "CANDIDATE" && x.service === SERVICE));
  return { version: after.version, expiration, uploadSuccess: Boolean(result) };
}

async function requestProbe(mode, ordinal, run, secret) {
  const started = performance.now();
  try {
    const response = await fetch(
      ORIGIN + PREFIX + mode + "?run=" + encodeURIComponent(run) + "&ordinal=" + ordinal,
      {
        headers: { "x-cove-triad-key": secret, accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      },
    );
    const firstByteMs = performance.now() - started;
    const payload = await response.json();
    const fullMs = performance.now() - started;
    return {
      status: response.status,
      valid: response.status === 200 && payload?.valid === true && payload?.mode === mode,
      launched: true,
      firstByteMs: rounded(firstByteMs),
      fullMs: rounded(fullMs),
      workerMs: Number.isFinite(payload?.workerDurationMs) ? payload.workerDurationMs : null,
      sqlMs: Number.isFinite(payload?.d1SqlMs) ? payload.d1SqlMs : null,
      outsideSqlMs: Number.isFinite(payload?.d1OutsideSqlMs) ? payload.d1OutsideSqlMs : null,
      downstreamStatus: payload?.downstreamStatus || null,
    };
  } catch (error) {
    return {
      status: 0,
      valid: false,
      launched: true,
      fullMs: rounded(performance.now() - started),
      errorKind: error?.name === "TimeoutError" ? "timeout" : "request-failed",
    };
  }
}

async function summarize(mode, shape, offered, rows, elapsed) {
  const f = (field) => rows.map((r) => r[field]).filter(Number.isFinite);
  const valid = rows.filter((r) => r.valid).length;
  const sample = {
    mode,
    shape,
    offered,
    launched: rows.filter((r) => r.launched).length,
    valid,
    failed: offered - valid,
    dropped: rows.filter((r) => r.dropped).length,
    achievedRps: rounded((1000 * valid) / Math.max(1, elapsed)),
    ttfbP50Ms: rounded(pct(f("firstByteMs"), 0.5)),
    ttfbP95Ms: rounded(pct(f("firstByteMs"), 0.95)),
    ttfbP99Ms: rounded(pct(f("firstByteMs"), 0.99)),
    ttfbMaxMs: rounded(pct(f("firstByteMs"), 1)),
    workerP95Ms: rounded(pct(f("workerMs"), 0.95)),
    sqlP95Ms: rounded(pct(f("sqlMs"), 0.95)),
    outsideSqlP95Ms: rounded(pct(f("outsideSqlMs"), 0.95)),
    fullBodyP95Ms: rounded(pct(f("fullMs"), 0.95)),
    statusCounts: rows.reduce((o, r) => {
      const key = String(r.status || 0);
      o[key] = (o[key] || 0) + 1;
      return o;
    }, {}),
    releaseCertified: false,
  };
  evidence.results.push(sample);
  console.log(JSON.stringify({ event: "cove_private_stage_four_path", ...sample }));
  return sample;
}

async function phase(mode, shape, offered, spacingMs, run, secret) {
  const started = performance.now();
  const rows = [];
  const pending = new Set();
  for (let i = 0; i < offered; i++) {
    const target = started + i * spacingMs;
    await sleep(target - performance.now());
    const delay = performance.now() - target;
    if (delay > 100 || pending.size >= MAX_OUTSTANDING) {
      rows.push({ status: 0, valid: false, launched: false, dropped: true, launchDelayMs: delay });
      continue;
    }
    const task = requestProbe(mode, i, run, secret).then((result) => {
      rows.push({ ...result, launchDelayMs: delay, dropped: false });
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
  await Promise.allSettled([...pending]);
  return summarize(mode, shape, offered, rows, performance.now() - started);
}

async function warmup(run, secret) {
  const unauth = await fetch(ORIGIN + PREFIX + "noop?run=" + run + "&ordinal=0", {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(unauth.status, 404, "Public client cannot run stage diagnostics");
  for (const mode of MODES) {
    let result;
    for (let retry = 0; retry < 5; retry++) {
      result = await requestProbe(mode, retry, run, secret);
      if (result.valid) break;
      await sleep(1500);
    }
    assert.equal(result.valid, true, "Failed stage single-path warmup for " + mode +
      " (" + result.status + ")");
  }
}

async function campaign(secret) {
  const run = randomUUID().replaceAll("-", "").slice(0,24);
  await warmup(run, secret);
  for (const count of [1, 4, 8, 16, 24, 32]) {
    // Rotate mode order to avoid every rights test following no-DB warm cache.
    for (const mode of MODES.slice(count % 4).concat(MODES.slice(0, count % 4))) {
      const res = await phase(mode, "burst-" + count, count, 0, run, secret);
      if (res.failed >= STOP_AFTER_FAILURES)
        throw new Error("Stage test failed; stop offering additional load at " + mode + "/" + count);
    }
  }
  for (const rate of [10, 25]) {
    for (const mode of MODES) {
      const res = await phase(mode, rate + "-rps", rate * 2, 1000 / rate, run, secret);
      if (res.failed >= STOP_AFTER_FAILURES)
        throw new Error("Scheduled stage test failed; stop before higher rate at " + mode + "/" + rate);
    }
  }
  for (const mode of MODES) {
    const res = await phase(mode, "50-rps", 50, 20, run, secret);
    if (res.failed >= STOP_AFTER_FAILURES) break;
  }
}

function save() {
  mkdirSync("artifacts/causal-triad-stage", { recursive: true });
  writeFileSync(
    "artifacts/causal-triad-stage/controlled-worker-runs.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
}

async function main() {
  if (process.argv.includes("--restore-only")) {
    console.log(JSON.stringify({ event: "cove_stage_restore", clean: await rollbackIfDiagnostic() }));
    return;
  }
  const secret = randomBytes(32).toString("hex");
  let attempted = false;
  try {
    const deployed = await deployPrivateStage(secret);
    attempted = true;
    evidence.testVersion = deployed.version;
    evidence.beganAt = new Date().toISOString();
    await campaign(secret);
    evidence.campaignCompleted = true;
  } catch (error) {
    evidence.campaignCompleted = false;
    evidence.failure = (error instanceof Error ? error.message : "unknown").slice(0,240);
    throw error;
  } finally {
    if (attempted || process.env.COVE_ALLOW_SAFE_RESTORE === "1") {
      evidence.restoredOriginal = await rollbackIfDiagnostic();
    }
    evidence.endedAt = new Date().toISOString();
    save();
  }
}

if (import.meta.url === new URL("file://" + process.argv[1]).href)
  main().catch((error) => {
    console.error("Private staging control failed:", error instanceof Error ? error.message : "unknown");
    process.exitCode = 1;
  });
