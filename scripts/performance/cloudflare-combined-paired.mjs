// Staging-only paired latency experiment. No production routing, no rights cache,
// no public access: each worker has its own random 256-bit bearer gate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const baselineSha = "6d197e48b7255eb02e689674575287dba54a37a5";
const candidateSha = process.env.COVE_RECOVERY_CANDIDATE_SHA;
assert.match(candidateSha || "", /^[a-f0-9]{40}$/);
const configName = "wrangler.paired.toml";
const cohorts = {
  baseline: {
    dir: path.resolve(root, "../baseline"),
    name: "cove-combined-control-staging",
    sha: baselineSha,
  },
  current: { dir: root, name: "cove-combined-candidate-staging", sha: candidateSha },
};
const account = "d26430caa63ec55f6612e32f36aca5e9";
const databaseId = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const outDir = path.resolve(root, "../combined-paired-evidence");
fs.mkdirSync(outDir, { recursive: true });

function command(cwd, exe, args, env = {}, timeout = 200000, input) {
  const r = spawnSync(exe, args, {
    cwd,
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    const detail = (r.stderr || r.stdout || "")
      .slice(-2400)
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
    throw Error(`${exe} failed (${r.status}): ${r.error?.message || detail}`);
  }
  return (r.stdout || "").trim();
}

function prepareConfigs() {
  const template = fs.readFileSync(path.join(root, "wrangler.frontend.staging.toml"), "utf8");
  assert.match(template, /COVE_SSR_STAGING = "1"/);
  assert.match(template, /run_worker_first = true/);
  assert.match(template, /database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989"/);
  for (const cohort of Object.values(cohorts)) {
    // Force IDENTICAL ingress-edge placement in BOTH cohorts, independent of
    // current Smart Placement experiments. Test placement separately later.
    let config = template.replace(/\[placement\]\s*mode\s*=\s*"smart"\s*/m, "");
    config = config.replace(/^name = "cove-storefront-ssr-staging"$/m, `name = "${cohort.name}"`);
    // Cloudflare shares rate counters between scripts with the same namespace.
    // Each cohort has a different identifier, but the EXACT same limit/key
    // policy; neither cohort shares counters with the ordinary staging Worker.
    const namespace = cohort.name.includes("control") ? "731990" : "731991";
    config = config.replace('namespace_id = "731903"', `namespace_id = "${namespace}"`);
    assert.doesNotMatch(config, /^\[placement\]/m);
    assert.match(config, new RegExp(`name = "${cohort.name}"`));
    assert.match(config, new RegExp(`namespace_id = "${namespace}"`));
    fs.writeFileSync(path.join(cohort.dir, configName), config);
  }
}
function artifact(name) {
  const file = path.join(root, "artifacts", name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
function capture(prefix, name) {
  const src = path.join(root, "artifacts", name);
  if (!fs.existsSync(src)) return null;
  const dest = path.join(outDir, `${prefix}-${name}`);
  fs.renameSync(src, dest);
  return dest;
}
async function controlPlane(name, rotatedAt, previousId) {
  const uri = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/deployments`;
  for (let i = 0; i < 24; i++) {
    const r = await fetch(uri, {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    });
    const j = await r.json();
    if (!r.ok || !j.success) throw Error("Cloudflare control-plane deployment verification failed");
    const latest = j.result?.deployments?.[0];
    if (
      latest &&
      latest.id !== previousId &&
      Date.parse(latest.created_on) >= rotatedAt &&
      latest.versions?.some((v) => Number(v.percentage) === 100)
    )
      return {
        id: latest.id,
        created_on: latest.created_on,
        versions: latest.versions.map((v) => ({
          version_id: v.version_id,
          percentage: v.percentage,
        })),
      };
    await new Promise((done) => setTimeout(done, 1800));
  }
  throw Error("No confirmed 100% control-plane deployment");
}
function benchScript(label, cohort, script, outputName, run) {
  const env = {
    COVE_SSR_STAGING_ORIGIN: `https://${cohort.name}.cove-jibrilmohamud.workers.dev`,
    COVE_SSR_STAGING_GATE_KEY: cohort.key,
    COVE_FACET_VARIANT_OFFSET: cohort.name.includes("candidate") ? "4" : "0",
    COVE_EXPECT_PRESTART: "0",
    COVE_EXPECT_DISCOVERY_DEFER: "1",
    // Keep timestamp of secret change numeric only, not a token.
    COVE_STAGE_SECRET_ROTATION_EPOCH_MS: String(cohort.rotatedAt),
  };
  const at = new Date().toISOString();
  try {
    const output = command(root, "node", [script], env, 210000);
    const saved = capture(label, outputName);
    run.push({
      step: script,
      name: label,
      at,
      pass: true,
      saved,
      tail: output.slice(-380),
    });
    process.stdout.write(`${label} ${path.basename(script)} completed\n`);
  } catch (e) {
    const saved = capture(label, outputName);
    run.push({
      step: script,
      name: label,
      at,
      pass: false,
      saved,
      error: String(e).slice(0, 1000),
    });
    process.stdout.write(`::error::${label} ${path.basename(script)} failed strict validation\n`);
  }
}
async function deployFresh(cohort) {
  const arg = ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler"];
  command(cohort.dir, "npm", [...arg, "deploy", "--config", configName], {}, 180000);
  cohort.key = randomBytes(32).toString("hex");
  cohort.rotatedAt = Date.now();
  // No gate key, file, request headers or token is logged/artifacted.
  command(
    cohort.dir,
    "npm",
    [...arg, "secret", "put", "COVE_SSR_STAGING_GATE_KEY", "--config", configName],
    {},
    90000,
    cohort.key,
  );
  const state = await controlPlane(cohort.name, cohort.rotatedAt, cohort.deploymentId);
  cohort.deploymentId = state.id;
  // Control-plane polling does NOT warm the actual Worker URL.
  await new Promise((done) => setTimeout(done, 2000));
  return state;
}
async function d1Snapshot(since, until) {
  const time = (v) => new Date(v).toISOString().replace(/\.\d{3}Z$/, "Z");
  const q = `query { viewer { accounts(filter:{accountTag:"${account}"}) {
    d1QueriesAdaptiveGroups(limit:15,filter:{databaseId:"${databaseId}",
      datetime_geq:"${time(since)}",datetime_leq:"${time(until)}"},
      orderBy:[sum_queryDurationMs_DESC]) {
        count dimensions { query databaseRole } avg { queryDurationMs }
        sum { queryDurationMs rowsRead rowsWritten }
    }
  } } }`;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: q }),
    });
    const j = await r.json();
    if (!r.ok || j.errors) return { warning: "D1 analytics query unavailable" };
    return (j.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups || []).map((v) => ({
      fingerprint: v.dimensions.query?.replace(/\s+/g, " ").slice(0, 125),
      role: v.dimensions.databaseRole,
      calls: v.count,
      avgSqlMs: v.avg.queryDurationMs,
      totalSqlMs: v.sum.queryDurationMs,
      rowsRead: v.sum.rowsRead,
      rowsWritten: v.sum.rowsWritten,
    }));
  } catch {
    return { warning: "D1 analytics unavailable" };
  }
}

async function workerSnapshot(name, since, until) {
  const query = `query { viewer { accounts(filter:{accountTag:"${account}"}) {
    workersInvocationsAdaptive(limit:100,filter:{scriptName:"${name}",
      datetime_geq:"${since}",datetime_leq:"${until}"}) {
      dimensions { scriptName status }
      sum { requests errors }
      quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
    }
  } } }`;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    const j = await r.json();
    if (!r.ok || j.errors) return { warning: "Platform CPU/wall analytics unavailable" };
    const rows = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
    return rows.length
      ? {
          raw: rows,
          boundary:
            "Sampled platform invocation quantiles; includes assets, controls and deferred work. Not a per-response CPU attribution.",
        }
      : { warning: "Platform CPU/wall analytics not yet ingested; NOT zero CPU" };
  } catch {
    return { warning: "Platform CPU/wall analytics unavailable" };
  }
}

async function main() {
  assert.equal(process.env.COVE_PAIR_RELEASE_FREEZE, "1");
  assert.match(process.env.CLOUDFLARE_API_TOKEN || "", /\S/);
  const revision = {
    baseline: command(cohorts.baseline.dir, "git", ["rev-parse", "HEAD"]),
    current: command(cohorts.current.dir, "git", ["rev-parse", "HEAD"]),
  };
  assert.equal(revision.baseline, baselineSha);
  assert.equal(revision.current, candidateSha);
  prepareConfigs();
  assert.notEqual(cohorts.baseline.sha, cohorts.current.sha);
  const manifest = {
    revision,
    placement: "same-ingress-edge",
    config: "identical protected staging config, live production D1/R2",
    orderedTrials: [],
    outcomes: [],
    d1Intervals: [],
    startedAt: new Date().toISOString(),
  };
  let anyFailures = false;
  const first = Date.now();
  for (let round = 1; round <= 3; round++) {
    const order = round % 2 ? ["baseline", "current"] : ["current", "baseline"];
    for (const name of order) {
      const cohort = cohorts[name],
        label = `cold-${round}-${name}`;
      const began = Date.now();
      try {
        const deployment = await deployFresh(cohort);
        manifest.orderedTrials.push({
          round,
          name,
          begin: new Date(began).toISOString(),
          deployment,
        });
        benchScript(
          label,
          cohort,
          "scripts/check-cloudflare-ssr-staging.mjs",
          "cloudflare-ssr-staging-performance.json",
          manifest.outcomes,
        );
      } catch (e) {
        anyFailures = true;
        manifest.outcomes.push({
          name: label,
          pass: false,
          error: String(e).slice(0, 1200),
        });
      }
      const last = manifest.outcomes.at(-1);
      if (!last?.pass) anyFailures = true;
      manifest.d1Intervals.push({
        name: label,
        since: new Date(began).toISOString(),
        until: new Date().toISOString(),
        sql: await d1Snapshot(began, Date.now()),
      });
    }
  }
  // Flip order for each full 60-request cohort. Never substitute fast 401s
  // or errors for validated rights-authoritative HTML responses.
  // Reverse the previous trial order to detect time-correlated D1 contention.
  for (const name of ["baseline", "current", "current", "baseline"]) {
    if (!cohorts[name].key) continue;
    const repeat = manifest.outcomes.some((v) => v.name === `concurrency-${name}`);
    // Keep independently repeated sweeps in separate rate-limit periods,
    // with the production limiter and all background jobs left unchanged.
    if (repeat) await new Promise((done) => setTimeout(done, 61_000));
    const began = Date.now();
    benchScript(
      `concurrency-${name}${repeat ? "-repeat" : ""}`,
      cohorts[name],
      "scripts/performance/cloudflare-concurrency.mjs",
      "cloudflare-concurrency-performance.json",
      manifest.outcomes,
    );
    manifest.d1Intervals.push({
      name: `concurrency-${name}${repeat ? "-repeat" : ""}`,
      since: new Date(began).toISOString(),
      until: new Date().toISOString(),
      sql: await d1Snapshot(began, Date.now()),
    });
    if (!manifest.outcomes.at(-1).pass) anyFailures = true;
  }
  // This clean experiment intentionally makes NO staging-only API changes.
  // The unmodified frozen comparator has no literary-benchmark route. Mixed
  // literary loads remain in the separate rights-safe candidate experiment.
  // Run genuine full-catalog numerical facet aggregation in parallel with
  // rights-authoritative home renders; never accept 401/503 as successful
  // performance samples. Offset count-only cache identities per cohort.
  // The experiment is an isolated Worker and does not mutate production routes.
  for (const name of ["baseline", "current"]) {
    const cohort = cohorts[name];
    if (!cohort.key) continue;
    // Separate these from the earlier full-home load's rate-limit window.
    await new Promise((done) => setTimeout(done, 61_000));
    const began = Date.now();
    benchScript(
      `mixed-facets-${name}`,
      cohort,
      "scripts/performance/cloudflare-facet-home-mixed.mjs",
      "cloudflare-facet-home-mixed.json",
      manifest.outcomes,
    );
    manifest.d1Intervals.push({
      name: `mixed-facets-${name}`,
      since: new Date(began).toISOString(),
      until: new Date().toISOString(),
      sql: await d1Snapshot(began, Date.now()),
    });
    if (!manifest.outcomes.at(-1).pass) anyFailures = true;
  }
  // The browser captures initial hydration D1 traffic and LCP element phase.
  // Optional below-fold network work should remain dormant until observed.
  for (const name of ["baseline", "current"]) {
    if (!cohorts[name].key) continue;
    benchScript(
      `browser-${name}`,
      cohorts[name],
      "scripts/performance/cloudflare-browser.mjs",
      "cloudflare-browser-performance.json",
      manifest.outcomes,
    );
    if (!manifest.outcomes.at(-1).pass) anyFailures = true;
  }
  // Immediate analytics were empty in both frozen runs. Query the historical
  // intervals again after browser work, and label absent data as unavailable.
  for (const interval of manifest.d1Intervals) {
    interval.sql = await d1Snapshot(interval.since, interval.until);
    if (Array.isArray(interval.sql) && !interval.sql.length)
      interval.sql = { warning: "Analytics unavailable or not yet ingested; NOT zero D1 activity" };
  }
  manifest.timingCaveat =
    "Workers performance.now advances only on I/O. cove_total is not complete CPU/wall time; residual includes unmeasured CPU and must not be labeled network-only.";
  manifest.workerPlatform = {};
  for (const [name, cohort] of Object.entries(cohorts)) {
    manifest.workerPlatform[name] = await workerSnapshot(
      cohort.name,
      manifest.startedAt,
      new Date().toISOString(),
    );
  }
  // Results are paired by the same bounded concurrency wave, not by
  // independent days/regions. If colos fail to overlap the comparison is
  // explicitly marked INCONCLUSIVE rather than mislabeling an edge effect
  // as a code regression.
  const byName = (name) => {
    const entry = manifest.outcomes.find((v) => v.name === name);
    if (!entry?.saved) return null;
    try {
      return JSON.parse(fs.readFileSync(entry.saved, "utf8"));
    } catch {
      return null;
    }
  };
  manifest.comparison = {
    baseline: {},
    current: {},
    matchedColos: true,
    decision: "not a production release approval",
  };
  for (const name of ["baseline", "current"]) {
    const conc = byName(`concurrency-${name}`);
    const browser = byName(`browser-${name}`);
    const cold = [1, 2, 3].map((round) => {
      const trial = byName(`cold-${round}-${name}`);
      if (!trial) return { round, valid: false };
      return {
        round,
        valid: trial.status === "pass",
        firstTtfbMs: trial.results?.find((r) => r.sequence === 1)?.ttfbMs ?? null,
        maxTtfbMs: Math.max(0, ...(trial.results || []).map((r) => r.ttfbMs || 0)),
        p95TtfbMs: trial.p95,
        slowSamples: trial.slowSamples,
        failures: trial.failures?.length ?? 0,
        colos: [...new Set((trial.results || []).map((r) => r.cfColo))].sort(),
      };
    });
    manifest.comparison[name] = {
      cold,
      waves:
        conc?.summaries?.map((v) => ({
          concurrency: v.concurrency,
          count: v.requests,
          valid: v.successes,
          maxTtfbMs: v.maxMs,
          p95TtfbMs: v.p95Ms,
          p99TtfbMs: v.p99Ms,
          colos: v.colo,
          pass: v.pass,
        })) ?? [],
      protectedEdgeControl: conc?.controlSummaries ?? null,
      browserLcp: browser?.profiles ?? null,
    };
  }
  const oldWaves = manifest.comparison.baseline.waves;
  const newWaves = manifest.comparison.current.waves;
  const overlaps = oldWaves.map((old) => {
    const current = newWaves.find((v) => v.concurrency === old.concurrency);
    return {
      concurrency: old.concurrency,
      sharedColos: (old.colos || []).filter((colo) => current?.colos?.includes(colo)),
      maxDeltaMs:
        Number.isFinite(current?.maxTtfbMs) && Number.isFinite(old.maxTtfbMs)
          ? current.maxTtfbMs - old.maxTtfbMs
          : null,
    };
  });
  manifest.comparison.geographicWaveMatches = overlaps;
  manifest.comparison.matchedColos =
    overlaps.length === 5 && overlaps.every((v) => v.sharedColos.length > 0);
  if (!manifest.comparison.matchedColos) {
    manifest.comparison.decision =
      "INCONCLUSIVE geographic comparison; never infer a code regression from unmatched colos";
  }
  // A hard <800ms gate is necessary but not sufficient for commercial-grade
  // headroom. Require every fully licensed cold read and 1/4/8/16 request
  // comfortably below 800ms, rather than counting a 799ms edge as a win.
  const candidate = manifest.comparison.current;
  const required = [1, 4, 8, 16, 32];
  const waves = candidate.waves;
  const mobileLcp = candidate.browserLcp?.find((p) => p.profile === "mobile-4g");
  manifest.comparison.commercialHeadroom = {
    coldDeployments: candidate.cold.length,
    allColdUnder700:
      candidate.cold.length === 3 &&
      candidate.cold.every(
        (trial) =>
          trial.valid &&
          trial.failures === 0 &&
          Number.isFinite(trial.maxTtfbMs) &&
          trial.maxTtfbMs <= 700,
      ),
    concurrent1to16Under700: [1, 4, 8, 16].every((level) => {
      const wave = waves.find((w) => w.concurrency === level);
      return (
        !!wave &&
        wave.valid === wave.count &&
        Number.isFinite(wave.maxTtfbMs) &&
        wave.maxTtfbMs <= 700 &&
        Number.isFinite(wave.p95TtfbMs) &&
        wave.p95TtfbMs <= 600
      );
    }),
    concurrent32Under800: required.every((level) => {
      const wave = waves.find((w) => w.concurrency === level);
      return !!wave && wave.valid === wave.count && wave.maxTtfbMs < 800;
    }),
    mobileLcpP75Under2200:
      !!mobileLcp &&
      mobileLcp.pass &&
      Number.isFinite(mobileLcp.lcpP75Ms) &&
      mobileLcp.lcpP75Ms <= 2200,
    geographicallyComparable: manifest.comparison.matchedColos,
    actualFacetLoadPassed:
      manifest.outcomes.filter((v) => v.name.startsWith("mixed-facets-")).length === 2 &&
      manifest.outcomes.filter((v) => v.name.startsWith("mixed-facets-")).every((v) => v.pass),
  };
  const gate = manifest.comparison.commercialHeadroom;
  manifest.comparison.commercialHeadroomPassed = Object.entries(gate)
    .filter(([key]) => key !== "coldDeployments")
    .every(([, value]) => value === true);
  if (!manifest.comparison.commercialHeadroomPassed) {
    anyFailures = true;
    manifest.comparison.decision =
      "REJECT: cold or concurrent max TTFB, p95, mobile LCP, mixed-rights catalog or same-colo headroom unproven";
  }
  // Decompose the slowest REAL licensed responses without inventing queue
  // metrics. cove_backend_catalog includes D1 service transit/queue and SQL;
  // the catalog SQL portion is the measured authoritative execution time.
  // The remaining client-to-server timing is UNATTRIBUTED rather than
  // mislabeled as network, CPU, or database waiting.
  const phaseDuration = (timing, name) => {
    const hit = String(timing || "").match(new RegExp(`(?:^|,)\\s*${name};dur=(\\d+(?:\\.\\d+)?)`));
    return hit ? Number(hit[1]) : null;
  };
  manifest.comparison.tailAttribution = {};
  for (const name of ["baseline", "current"]) {
    const samples = [
      ...(byName(`concurrency-${name}`)?.results || []),
      ...(byName(`concurrency-${name}-repeat`)?.results || []),
    ]
      .filter((row) => !row.error && [16, 32].includes(row.concurrency))
      .sort((a, b) => b.ttfbMs - a.ttfbMs)
      .slice(0, 8);
    manifest.comparison.tailAttribution[name] = samples.map((row) => {
      const catalogWall = phaseDuration(row.timing, "cove_backend_catalog");
      const catalogSql = phaseDuration(row.timing, "cove_backend_catalog_sql");
      return {
        concurrency: row.concurrency,
        ttfbMs: row.ttfbMs,
        workerMeasuredMs: row.workerMs,
        unaccountedMs: row.residualMs,
        runnerQueueMs: row.clientQueueMs,
        catalogPhaseMs: catalogWall,
        catalogSqlMs: catalogSql,
        catalogNonSqlPhaseMs:
          catalogWall !== null && catalogSql !== null
            ? Math.max(0, Math.round(catalogWall - catalogSql))
            : null,
        note: "Non-SQL phase can include D1 scheduling/transit and JS work; unaccounted TTFB can include Worker CPU/edge dispatch. Neither is an exact queue-time measurement.",
      };
    });
  }
  manifest.finishedAt = new Date().toISOString();
  manifest.wallMs = Date.now() - first;
  // Importantly, the cohort secret keys are not part of manifest or files.
  fs.writeFileSync(
    path.join(outDir, "paired-release-gate.json"),
    JSON.stringify(manifest, null, 2),
  );
  process.stdout.write(
    `Baseline ${baselineSha}, current ${candidateSha}. Evidence stored under combined-paired-evidence/.\n`,
  );
  process.stdout.write(
    `Validated steps: ${manifest.outcomes.filter((x) => x.pass).length}/${manifest.outcomes.length}.\n`,
  );
  if (anyFailures) process.exitCode = 1;
}
await main();
