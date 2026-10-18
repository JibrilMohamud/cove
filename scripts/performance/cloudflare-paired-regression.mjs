// Staging-only paired latency experiment. No production routing, no rights cache,
// no public access: each worker has its own random 256-bit bearer gate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const baselineSha = "2ae0431c02da435797e749b9d46201583d47ea91";
const candidateSha = "6c1e78041708e1d00883beb14565a96d631246e9";
const configName = "wrangler.paired.toml";
const cohorts = {
  baseline: {
    dir: path.resolve(root, "../baseline"),
    name: "cove-perf-baseline-staging",
    sha: baselineSha,
  },
  current: { dir: root, name: "cove-perf-current-staging", sha: candidateSha },
};
const account = "d26430caa63ec55f6612e32f36aca5e9";
const databaseId = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const outDir = path.resolve(root, "../paired-evidence");
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
  const template = fs.readFileSync(
    path.join(root, "wrangler.frontend.staging.toml"),
    "utf8",
  );
  assert.match(template, /COVE_SSR_STAGING = "1"/);
  assert.match(template, /run_worker_first = true/);
  assert.match(
    template,
    /database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989"/,
  );
  for (const cohort of Object.values(cohorts)) {
    // Force IDENTICAL ingress-edge placement in BOTH cohorts, independent of
    // current Smart Placement experiments. Test placement separately later.
    let config = template.replace(/\[placement\]\s*mode\s*=\s*"smart"\s*/m, "");
    config = config.replace(
      /^name = "cove-storefront-ssr-staging"$/m,
      `name = "${cohort.name}"`,
    );
    assert.doesNotMatch(config, /^\[placement\]/m);
    assert.match(config, new RegExp(`name = "${cohort.name}"`));
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
async function controlPlane(name) {
  const uri = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/deployments`;
  for (let i = 0; i < 24; i++) {
    const r = await fetch(uri, {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    });
    const j = await r.json();
    if (!r.ok || !j.success)
      throw Error("Cloudflare control-plane deployment verification failed");
    const latest = j.result?.deployments?.[0];
    if (latest && latest.versions?.some((v) => Number(v.percentage) === 100))
      return {
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
    process.stdout.write(
      `::error::${label} ${path.basename(script)} failed strict validation\n`,
    );
  }
}
async function deployFresh(cohort) {
  const arg = ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler"];
  command(
    cohort.dir,
    "npm",
    [...arg, "deploy", "--config", configName],
    {},
    180000,
  );
  cohort.key = randomBytes(32).toString("hex");
  cohort.rotatedAt = Date.now();
  // No gate key, file, request headers or token is logged/artifacted.
  command(
    cohort.dir,
    "npm",
    [
      ...arg,
      "secret",
      "put",
      "COVE_SSR_STAGING_GATE_KEY",
      "--config",
      configName,
    ],
    {},
    90000,
    cohort.key,
  );
  const state = await controlPlane(cohort.name);
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
    return (j.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups || []).map(
      (v) => ({
        fingerprint: v.dimensions.query?.replace(/\s+/g, " ").slice(0, 125),
        role: v.dimensions.databaseRole,
        calls: v.count,
        avgSqlMs: v.avg.queryDurationMs,
        totalSqlMs: v.sum.queryDurationMs,
        rowsRead: v.sum.rowsRead,
        rowsWritten: v.sum.rowsWritten,
      }),
    );
  } catch {
    return { warning: "D1 analytics unavailable" };
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
  for (const name of ["current", "baseline"]) {
    if (!cohorts[name].key) continue;
    const began = Date.now();
    benchScript(
      `concurrency-${name}`,
      cohorts[name],
      "scripts/performance/cloudflare-concurrency.mjs",
      "cloudflare-concurrency-performance.json",
      manifest.outcomes,
    );
    manifest.d1Intervals.push({
      name: `concurrency-${name}`,
      since: new Date(began).toISOString(),
      until: new Date().toISOString(),
      sql: await d1Snapshot(began, Date.now()),
    });
    if (!manifest.outcomes.at(-1).pass) anyFailures = true;
  }
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
        firstTtfbMs:
          trial.results?.find((r) => r.sequence === 1)?.ttfbMs ?? null,
        maxTtfbMs: Math.max(
          0,
          ...(trial.results || []).map((r) => r.ttfbMs || 0),
        ),
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
      sharedColos: (old.colos || []).filter((colo) =>
        current?.colos?.includes(colo),
      ),
      maxDeltaMs:
        Number.isFinite(current?.maxTtfbMs) && Number.isFinite(old.maxTtfbMs)
          ? current.maxTtfbMs - old.maxTtfbMs
          : null,
    };
  });
  manifest.comparison.geographicWaveMatches = overlaps;
  manifest.comparison.matchedColos =
    overlaps.length === 4 && overlaps.every((v) => v.sharedColos.length > 0);
  if (!manifest.comparison.matchedColos) {
    manifest.comparison.decision =
      "INCONCLUSIVE geographic comparison; never infer a code regression from unmatched colos";
  }
  manifest.finishedAt = new Date().toISOString();
  manifest.wallMs = Date.now() - first;
  // Importantly, the cohort secret keys are not part of manifest or files.
  fs.writeFileSync(
    path.join(outDir, "paired-release-gate.json"),
    JSON.stringify(manifest, null, 2),
  );
  process.stdout.write(
    `Baseline ${baselineSha}, current ${candidateSha}. Evidence stored under paired-evidence/.\n`,
  );
  process.stdout.write(
    `Validated steps: ${manifest.outcomes.filter((x) => x.pass).length}/${manifest.outcomes.length}.\n`,
  );
  if (anyFailures) process.exitCode = 1;
}
await main();
