import assert from "node:assert/strict";
import { strictTtfbTailAttribution } from "./strict-ttfb-tail-attribution.mjs";
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
    headers: {
      authorization: "Bearer " + CF_TOKEN,
      accept: "application/json",
      ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (!res.ok || !json.success)
    throw new Error(
      "Cloudflare " +
        method +
        " " +
        path.split("?")[0] +
        " failed HTTP " +
        res.status +
        ": " +
        (json.errors || []).map((e) => e.code).join(","),
    );
  return json.result;
}

async function scriptState() {
  const [d, sc, ingress] = await Promise.all([
    api("/workers/scripts/" + SCRIPT + "/deployments"),
    api("/workers/scripts/" + SCRIPT + "/schedules"),
    api("/workers/scripts/" + SCRIPT + "/subdomain"),
  ]);
  const version = d.deployments?.[0]?.versions?.[0]?.version_id;
  const details = version ? await api("/workers/scripts/" + SCRIPT + "/versions/" + version) : null;
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

// The synthetic 50k-product fixture can prove D1 territorial-read capacity,
// but MUST NOT be used to claim full commercial catalog capacity unless the
// same top-96 ranked seed has at least 25 CURRENT eligible retail offers.
// The preflight runs before touching either private Worker deployment.
async function requireSyntheticRetailOffers() {
  const statement = `WITH ranked AS MATERIALIZED (
    SELECT product_id FROM catalog_search_documents INDEXED BY idx_search_popular_stable
    ORDER BY fore_bestseller_score DESC,external_book_id ASC,product_id ASC LIMIT 96
  )
  SELECT COUNT(*) AS eligible_offer_count FROM ranked r
  JOIN products p ON p.id=r.product_id
  JOIN editions e ON e.id=p.edition_id
  JOIN catalog_search_documents d ON d.product_id=p.id
  WHERE p.storefront_status='active' AND p.source_name<>'upload'
    AND e.release_status IN ('available','preorder')
    AND d.suppressed=0 AND d.availability='available' AND d.currency='USD'
    AND EXISTS (SELECT 1 FROM retail_product_availability_rows rpa
      WHERE rpa.product_id=p.id AND rpa.territory_code='US')
    AND EXISTS (SELECT 1 FROM offers o
      WHERE o.product_id=p.id AND o.sales_channel='retail' AND o.currency='USD'
        AND o.active=1
        AND (o.starts_at IS NULL OR o.starts_at<=datetime('now'))
        AND (o.ends_at IS NULL OR o.ends_at>datetime('now')))`;
  const result = await api("/d1/database/" + DB + "/query", {
    method: "POST",
    body: JSON.stringify({ sql: statement }),
  });
  const eligible = Number(result?.[0]?.results?.[0]?.eligible_offer_count);
  evidence.syntheticLiveOfferWitnessCount = Number.isSafeInteger(eligible) ? eligible : null;
  const minimum =
    process.argv.includes("--r2-page2-100rps") || process.argv.includes("--r2-cursor-100rps")
      ? 49
      : 25;
  evidence.syntheticRetailOfferParityProved = Number.isSafeInteger(eligible) && eligible >= minimum;
  assert.ok(
    evidence.syntheticRetailOfferParityProved,
    "Synthetic top-96 has fewer than " +
      minimum +
      " current eligible retail offers; refuse catalog capacity probe",
  );
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
        "workers/message":
          "Restore pinned original capacity driver after isolated synthetic performance test",
      },
    }),
  });
  // The deployment POST can acknowledge before a subsequent read is fully
  // consistent. Poll the ACTIVE version rather than treating propagation as
  // an unrelated writer. No third-party version is ever accepted.
  for (let i = 0; i < 12; i++) {
    const restored = await scriptState();
    if (restored.version === OLD_VERSION) {
      assertOriginal(restored);
      return true;
    }
    if (restored.version !== state.version)
      throw new Error("Unexpected third-party stage deployment during rollback");
    await sleep(500);
  }
  throw new Error("Original stage driver deployment was not verified after bounded rollback polls");
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
    data.append(
      filename,
      new Blob([readFileSync(file)], { type: "application/javascript+module" }),
      filename,
    );
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
  assert.ok(
    after.bindings.some((x) => x.name === "COVE_TRIAD_PROBE_GATE" && x.type === "secret_text"),
  );
  assert.ok(after.bindings.some((x) => x.name === "CANDIDATE" && x.service === SERVICE));
  return { version: after.version, expiration, uploadSuccess: Boolean(result) };
}

// Ephemeral per-process only: no cursor ever enters recorded metrics or logs.
let signedStageCursor = null;
async function requestProbe(mode, ordinal, run, secret) {
  const started = performance.now();
  try {
    const response = await fetch(
      ORIGIN + PREFIX + mode + "?run=" + encodeURIComponent(run) + "&ordinal=" + ordinal,
      {
        headers: {
          "x-cove-triad-key": secret,
          accept: "application/json",
          ...(mode === "r2cursor" && signedStageCursor
            ? { "x-cove-stage-cursor": signedStageCursor }
            : {}),
        },
        signal: AbortSignal.timeout(12000),
      },
    );
    const firstByteMs = performance.now() - started;
    const payload = await response.json();
    if (mode === "r2cursorseed") {
      signedStageCursor = null;
      if (
        response.status === 200 &&
        payload?.valid === true &&
        typeof payload.cursorToken === "string" &&
        payload.cursorToken.length <= 768 &&
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(payload.cursorToken)
      )
        signedStageCursor = payload.cursorToken;
    }
    const fullMs = performance.now() - started;
    return {
      status: response.status,
      valid:
        response.status === 200 &&
        payload?.valid === true &&
        payload?.mode === mode &&
        (mode !== "r2cursorseed" || signedStageCursor !== null),
      launched: true,
      firstByteMs: rounded(firstByteMs),
      fullMs: rounded(fullMs),
      workerMs: Number.isFinite(payload?.workerDurationMs) ? payload.workerDurationMs : null,
      downstreamFirstByteMs: Number.isFinite(payload?.downstreamFirstByteMs)
        ? payload.downstreamFirstByteMs
        : null,
      sqlMs: Number.isFinite(payload?.d1SqlMs) ? payload.d1SqlMs : null,
      outsideSqlMs: Number.isFinite(payload?.d1OutsideSqlMs) ? payload.d1OutsideSqlMs : null,
      downstreamStatus: payload?.downstreamStatus ?? null,
      resultKind: typeof payload?.resultKind === "string" ? payload.resultKind : null,
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
    tailAttribution: strictTtfbTailAttribution(rows),
    sqlP95Ms: rounded(pct(f("sqlMs"), 0.95)),
    outsideSqlP95Ms: rounded(pct(f("outsideSqlMs"), 0.95)),
    fullBodyP95Ms: rounded(pct(f("fullMs"), 0.95)),
    statusCounts: rows.reduce((o, r) => {
      const key = String(r.status || 0);
      o[key] = (o[key] || 0) + 1;
      return o;
    }, {}),
    downstreamStatusCounts: rows
      .filter((r) => r.launched)
      .reduce((o, r) => {
        const key = String(r.downstreamStatus ?? 0);
        o[key] = (o[key] || 0) + 1;
        return o;
      }, {}),
    failureKindCounts: rows
      .filter((r) => !r.valid)
      .reduce((o, r) => {
        const key = r.resultKind || r.errorKind || (r.dropped ? "generator-drop" : "unclassified");
        o[key] = (o[key] || 0) + 1;
        return o;
      }, {}),
    invalidUpstream200: rows.filter((r) => !r.valid && r.downstreamStatus === 200).length,
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
  // The version API can become active before workers.dev propagation finishes.
  // The old gated driver returns 403; the new private diagnostic returns 404.
  // Do not mistake deployment propagation for a failed security assertion.
  let unauthorizedStatus = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const unauth = await fetch(ORIGIN + PREFIX + "noop?run=" + run + "&ordinal=0", {
      signal: AbortSignal.timeout(3000),
    });
    unauthorizedStatus = unauth.status;
    if (unauthorizedStatus === 404) break;
    await sleep(1000);
  }
  assert.equal(unauthorizedStatus, 404, "Private staging route did not propagate safely");
  // The rights-only experiment must never depend on a separately deployed
  // candidate endpoint. The same private driver verifies no-DB and live D1.
  const warmModes = process.argv.includes("--r2-cursor-100rps")
    ? ["noop", "r2seed", "r2cursorseed", "r2cursor"]
    : process.argv.includes("--r2-page2-100rps")
      ? ["noop", "r2seed", "r2page2"]
      : process.argv.includes("--r2-retail-100rps")
        ? ["noop", "r2seed", "r2live"]
        : process.argv.includes("--rights-only-100rps")
          ? ["noop", "rights"]
          : MODES;
  for (const mode of warmModes) {
    let result;
    for (let retry = 0; retry < 5; retry++) {
      result = await requestProbe(mode, retry, run, secret);
      if (result.valid) break;
      await sleep(1500);
    }
    assert.equal(
      result.valid,
      true,
      "Failed stage single-path warmup for " + mode + " (" + result.status + ")",
    );
  }
}

async function campaign(secret) {
  const run = randomUUID().replaceAll("-", "").slice(0, 24);
  await warmup(run, secret);
  const page2Campaign = process.argv.includes("--r2-page2-100rps");
  const cursorCampaign = process.argv.includes("--r2-cursor-100rps");
  if (cursorCampaign || page2Campaign || process.argv.includes("--r2-retail-100rps")) {
    const stageMode = cursorCampaign ? "r2cursor" : page2Campaign ? "r2page2" : "r2live";
    const metricPrefix = cursorCampaign ? "r2Cursor" : page2Campaign ? "r2Page2" : "r2Retail";
    const failurePrefix = cursorCampaign
      ? "r2-cursor"
      : page2Campaign
        ? "r2-page-two"
        : "r2-retail";
    // This experiment isolates live primary-D1 rights + retail offer validation
    // from R2 display-only books. It cannot certify full bookstore parity.
    evidence.r2RetailPresentationOnly = true;
    evidence.fullCatalogParityProved = false;
    evidence.productionReleaseEligible = false;
    const strict = (p, offered) =>
      p.valid === offered &&
      p.dropped === 0 &&
      p.ttfbP95Ms !== null &&
      p.ttfbP95Ms < 600 &&
      p.ttfbP99Ms < 750 &&
      p.ttfbMaxMs < 800;
    for (const concurrency of [1, 4, 8, 16, 32]) {
      const result = await phase(stageMode, "burst-" + concurrency, concurrency, 0, run, secret);
      if (result.valid !== concurrency || result.dropped !== 0 || result.ttfbMaxMs >= 800) {
        evidence.stopReason = failurePrefix + "-burst-failed-" + concurrency;
        throw Error("Private R2 retail candidate failed burst gate");
      }
    }
    const noDb = await phase("noop", "100-rps-no-db-control-20s", 2000, 10, run, secret);
    evidence.noDbControlPassed = strict(noDb, 2000);
    if (!evidence.noDbControlPassed) {
      evidence.stopReason = "no-db-control-failed";
      throw Error("100-RPS no-database driver control failed");
    }
    const refresh = async () => {
      const seed = await requestProbe("r2seed", 0, run, secret);
      if (!seed.valid) {
        evidence.stopReason = "r2-snapshot-refresh-failed";
        throw Error("Private R2 display snapshot refresh failed");
      }
      if (cursorCampaign) {
        signedStageCursor = null;
        const cursor = await requestProbe("r2cursorseed", 0, run, secret);
        if (!cursor.valid || !signedStageCursor) {
          evidence.stopReason = "signed-cursor-preflight-failed";
          throw Error("Protected stage cursor could not be obtained from current first page");
        }
      }
    };
    await refresh();
    const fifty = await phase(stageMode, "50-rps-20s", 1000, 20, run, secret);
    evidence[metricPrefix + "50Passed"] = strict(fifty, 1000);
    if (!evidence[metricPrefix + "50Passed"]) {
      evidence.stopReason = failurePrefix + "-50-rps-gate-failed";
      throw Error("Private R2 retail catalog 50-RPS strict gate failed");
    }
    for (let trial = 1; trial <= 2; trial++) {
      await refresh();
      const hundred = await phase(stageMode, "100-rps-20s-phase-" + trial, 2000, 10, run, secret);
      evidence[metricPrefix + "100RpsPhases"] = trial;
      if (!strict(hundred, 2000)) {
        evidence.stopReason = failurePrefix + "-100-rps-phase-" + trial + "-failed";
        evidence[metricPrefix + "100RpsPassed"] = false;
        throw Error("Private R2 retail catalog 100-RPS strict phase failed");
      }
    }
    evidence[metricPrefix + "100RpsPassed"] = true;
    return;
  }
  if (process.argv.includes("--rights-only-100rps")) {
    // This capacity floor intentionally excludes retail offer verification.
    evidence.syntheticRetailOfferParityProved = false;
    evidence.rightsOnlyCurrentD1 = true;
    evidence.catalogHydrationIncluded = false;
    evidence.marketContextIncluded = false;
    evidence.productionReleaseEligible = false;
    const meets = (phase, offered) =>
      phase.valid === offered &&
      phase.dropped === 0 &&
      phase.ttfbP95Ms !== null &&
      phase.ttfbP95Ms < 600 &&
      phase.ttfbP99Ms < 750 &&
      phase.ttfbMaxMs < 800;
    const noDb = await phase("noop", "100-rps-no-db-control-20s", 2000, 10, run, secret);
    evidence.noDbControlPassed = meets(noDb, 2000);
    if (!evidence.noDbControlPassed) {
      evidence.rights100RpsTwoPhasePassed = false;
      evidence.stopReason = "no-db-offered-rate-control-failed";
      return;
    }
    const fifty = await phase("rights", "50-rps-20s", 1000, 20, run, secret);
    evidence.rights50Passed = meets(fifty, 1000);
    if (!evidence.rights50Passed) {
      evidence.rights100RpsTwoPhasePassed = false;
      evidence.stopReason = "sustained-rights-50-rps-failed";
      return;
    }
    for (let trial = 1; trial <= 2; trial++) {
      const hundred = await phase("rights", "100-rps-20s-phase-" + trial, 2000, 10, run, secret);
      evidence.rights100RpsPhases = trial;
      if (!meets(hundred, 2000)) {
        evidence.rights100RpsTwoPhasePassed = false;
        evidence.stopReason = "authoritative-rights-100-rps-phase-failed";
        return;
      }
    }
    evidence.rights100RpsTwoPhasePassed = true;
    return;
  }
  if (process.argv.includes("--single-only")) {
    evidence.referenceOnly = true;
    evidence.noMarketContextOrSecondaryChannel = true;
    const meets = (s, offered) =>
      s.valid === offered &&
      s.dropped === 0 &&
      s.ttfbP95Ms !== null &&
      s.ttfbP95Ms < 600 &&
      s.ttfbP99Ms < 750 &&
      s.ttfbMaxMs < 800;
    const fifty = await phase("single", "50-rps-20s", 1000, 20, run, secret);
    evidence.reference50Passed = meets(fifty, 1000);
    if (!evidence.reference50Passed) {
      evidence.skipped100Rps = "single-authority-50-rps-gate-failed";
      return;
    }
    for (let trial = 1; trial <= 2; trial++) {
      const hundred = await phase("single", "100-rps-20s-phase-" + trial, 2000, 10, run, secret);
      evidence.reference100RpsPhases = trial;
      if (!meets(hundred, 2000)) {
        evidence.reference100RpsTwoPhasePassed = false;
        return;
      }
    }
    evidence.reference100RpsTwoPhasePassed = true;
    return;
  }
  if (process.argv.includes("--catalog-only")) {
    const diagnostic = await phase("catalog", "50-rps-20s", 1000, 20, run, secret);
    evidence.diagnosticOnly = true;
    evidence.unresolvedFailures = diagnostic.failed;
    // Collect classification even when validity fails. No escalation to
    // sustained 100-RPS or authorization to change production routing.
    return;
  }
  for (const count of [1, 4, 8, 16, 24, 32]) {
    // Rotate mode order to avoid every rights test following no-DB warm cache.
    for (const mode of MODES.slice(count % 4).concat(MODES.slice(0, count % 4))) {
      const res = await phase(mode, "burst-" + count, count, 0, run, secret);
      if (res.failed >= STOP_AFTER_FAILURES)
        throw new Error(
          "Stage test failed; stop offering additional load at " + mode + "/" + count,
        );
    }
  }
  for (const rate of [10, 25]) {
    for (const mode of MODES) {
      const res = await phase(mode, rate + "-rps", rate * 2, 1000 / rate, run, secret);
      if (res.failed >= STOP_AFTER_FAILURES)
        throw new Error(
          "Scheduled stage test failed; stop before higher rate at " + mode + "/" + rate,
        );
    }
  }
  for (const mode of MODES) {
    const res = await phase(mode, "50-rps", 50, 20, run, secret);
    if (res.failed >= STOP_AFTER_FAILURES)
      throw new Error("Short 50-RPS stage path failed; refuse sustained escalation");
  }
  // Sustain the real synthetic catalog before offering a 100-RPS stage phase.
  // Two 100-RPS x 20-second phases are diagnostic only; the user-facing
  // whole-site and four-colo acceptance remains a separate hard release gate.
  const sustained50 = await phase("catalog", "50-rps-20s", 1000, 20, run, secret);
  const meetsLatencyGate = (result, requests) =>
    result.valid === requests &&
    result.dropped === 0 &&
    result.ttfbP95Ms !== null &&
    result.ttfbP95Ms < 600 &&
    result.ttfbP99Ms < 750 &&
    result.ttfbMaxMs < 800;
  evidence.sustained50Passed = meetsLatencyGate(sustained50, 1000);
  if (!evidence.sustained50Passed) {
    evidence.skipped100Rps = "sustained-50-rps-catalog-gate-failed";
    throw new Error(
      "20-second 50-RPS synthetic catalog tail or validity gate failed; do not offer 100 RPS",
    );
  }
  for (let trial = 1; trial <= 2; trial++) {
    const result = await phase("catalog", "100-rps-20s-phase-" + trial, 2000, 10, run, secret);
    if (!meetsLatencyGate(result, 2000))
      throw new Error("Synthetic 100-RPS stage phase failed; retain full release blockade");
  }
  evidence.syntheticRps100TwoPhasePassed = true;
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
    console.log(
      JSON.stringify({ event: "cove_stage_restore", clean: await rollbackIfDiagnostic() }),
    );
    return;
  }
  const secret = randomBytes(32).toString("hex");
  let attempted = false;
  try {
    // Rights-only is a narrow capacity floor. Every full-catalog campaign
    // requires a real synthetic commercial-offer fixture before deployment.
    if (!process.argv.includes("--rights-only-100rps")) await requireSyntheticRetailOffers();
    const deployed = await deployPrivateStage(secret);
    attempted = true;
    evidence.testVersion = deployed.version;
    evidence.beganAt = new Date().toISOString();
    await campaign(secret);
    evidence.campaignCompleted = true;
  } catch (error) {
    evidence.campaignCompleted = false;
    evidence.failure = (error instanceof Error ? error.message : "unknown").slice(0, 240);
    throw error;
  } finally {
    try {
      if (attempted || process.env.COVE_ALLOW_SAFE_RESTORE === "1") {
        evidence.restoredOriginal = await rollbackIfDiagnostic();
      }
    } catch (error) {
      evidence.rollbackFailureKind =
        error instanceof Error &&
        error.message.includes("Original stage driver deployment was not verified")
          ? "rollback-propagation-timeout"
          : "rollback-not-independently-certified";
      throw error;
    } finally {
      evidence.endedAt = new Date().toISOString();
      save();
    }
  }
}

if (import.meta.url === new URL("file://" + process.argv[1]).href)
  main().catch((error) => {
    console.error(
      "Private staging control failed:",
      error instanceof Error ? error.message : "unknown",
    );
    process.exitCode = 1;
  });
