// Diagnostic-only, non-public stage Worker. Never bind production D1.
// The three controls share one caller, schedule, region and synthetic identity distribution.
// In deployed use BACKEND and GATE are inherited from the existing private stage driver.
const STAGE_DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const CANDIDATE = "cove-presentation-r2-candidate-stage";
const MAX_OUTSTANDING = 64;
const CATALOG_URL =
  "https://cove-presentation-r2-proof-20261114.cove-jibrilmohamud.workers.dev/api/fore/catalog";
const MODES = ["noop", "rights", "catalog"];
const RIGHTS_SQL = `WITH ranked AS MATERIALIZED (
 SELECT d.product_id,d.fore_bestseller_score sort_score,d.external_book_id sort_source
 FROM catalog_search_documents d INDEXED BY idx_search_popular_stable
 ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC LIMIT 96
)
SELECT d.product_id FROM ranked wanted
CROSS JOIN catalog_search_documents d ON d.product_id=wanted.product_id
CROSS JOIN products p ON p.id=d.product_id
CROSS JOIN editions e ON e.id=p.edition_id
LEFT JOIN publishers pub ON pub.id=e.publisher_id
WHERE p.storefront_status='active'
 AND p.source_name<>'upload'
 AND d.suppressed=0
 AND e.release_status IN ('available','preorder')
 AND d.availability=?
 AND EXISTS(SELECT 1 FROM retail_product_availability_rows rpa
    WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))
 AND d.currency=?
ORDER BY wanted.sort_score DESC,wanted.sort_source ASC,wanted.product_id ASC
LIMIT ?`;

export function triadStageBindingGuard(env) {
  return (
    env?.COVE_TRIAD_STAGE === "1" &&
    env?.COVE_TRIAD_SYNTHETIC_D1_ID === STAGE_DB &&
    env?.COVE_TRIAD_CANDIDATE === CANDIDATE &&
    typeof env?.DB?.prepare === "function" &&
    typeof env?.CANDIDATE?.fetch === "function" &&
    /^[a-f0-9]{64}$/.test(env?.BACKEND || "") &&
    /^[a-f0-9]{64}$/.test(env?.GATE || "")
  );
}
export const triadModes = Object.freeze([...MODES]);
export const triadSql = RIGHTS_SQL;

// TEST-NET IPv4 addresses, unique by request ordinal. Never use real identities.
export function stageSyntheticIp(i) {
  if (!Number.isSafeInteger(i) || i < 0) throw new RangeError("ordinal");
  return `192.0.2.${(i % 250) + 1}`;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
export function nearestRank(values, fraction) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.ceil(a.length * fraction) - 1];
}
export function summarizeTriad(mode, kind, offered, rows, durationMs) {
  const valid = rows.filter((x) => x.valid).length;
  const timed = rows.map((x) => x.ms).filter(Number.isFinite);
  const outside = rows.map((x) => x.outsideSqlMs).filter(Number.isFinite);
  return {
    mode,
    kind,
    offered,
    launched: rows.filter((x) => x.launched).length,
    completed: rows.length,
    valid,
    failed: offered - valid,
    dropped: rows.filter((x) => x.dropped).length,
    delayed100ms: rows.filter((x) => x.launchDelayMs >= 100).length,
    achievedRps: durationMs > 0 ? Number(((valid * 1000) / durationMs).toFixed(2)) : null,
    p50Ms: nearestRank(timed, 0.5),
    p95Ms: nearestRank(timed, 0.95),
    p99Ms: nearestRank(timed, 0.99),
    maxMs: nearestRank(timed, 1),
    outsideSqlP95Ms: nearestRank(outside, 0.95),
    sqlP95Ms: nearestRank(rows.map((x) => x.sqlMs).filter(Number.isFinite), 0.95),
    statusCounts: rows.reduce((a, r) => {
      const k = String(r.status || 0);
      a[k] = (a[k] || 0) + 1;
      return a;
    }, {}),
    releaseCertified: false,
  };
}
export async function singleTriadProbe(mode, env, ordinal, runId) {
  if (!triadStageBindingGuard(env)) throw new Error("stage-bindings-not-proven");
  if (!MODES.includes(mode)) throw new Error("invalid-diagnostic-mode");
  const started = performance.now();
  try {
    if (mode === "noop") return { status: 200, valid: true, ms: performance.now() - started };
    if (mode === "rights") {
      const result = await env.DB.prepare(RIGHTS_SQL).bind("available", "US", "USD", 25).all();
      const ids = (result.results || []).map((r) => r.product_id);
      const sqlMs = Number(result.meta?.duration);
      const ms = performance.now() - started;
      return {
        status: 200,
        valid:
          ids.length === 25 &&
          new Set(ids).size === 25 &&
          ids.every((id) => typeof id === "string" && id.startsWith("perf-synth-")),
        ms,
        sqlMs: Number.isFinite(sqlMs) ? sqlMs : null,
        outsideSqlMs: Number.isFinite(sqlMs) && sqlMs <= ms ? ms - sqlMs : null,
      };
    }
    const url =
      CATALOG_URL +
      "?sort=popular&page=1&currency=USD&__proof=" +
      encodeURIComponent(runId + "-" + ordinal);
    const ip = stageSyntheticIp(ordinal);
    const headers = {
      accept: "application/json",
      "x-cove-backend-token": env.BACKEND,
      "x-cove-client-country": "US",
      "x-cove-client-ip": ip,
      "cf-connecting-ip": ip,
    };
    const resp = await env.CANDIDATE.fetch(
      new Request(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10000),
      }),
    );
    const firstByteMs = performance.now() - started;
    const data = await resp.json();
    const ms = performance.now() - started;
    const ids = Array.isArray(data?.results) ? data.results.map((b) => b.productId) : [];
    return {
      status: resp.status,
      firstByteMs,
      ms,
      valid:
        resp.status === 200 &&
        ids.length === 24 &&
        new Set(ids).size === 24 &&
        ids.every((id) => typeof id === "string" && id.startsWith("perf-synth-")) &&
        resp.headers.get("x-cove-persistence") === "d1-r2",
    };
  } catch (error) {
    return {
      status: 0,
      valid: false,
      ms: performance.now() - started,
      errorKind: error?.name === "TimeoutError" ? "timeout" : "request-or-database-failure",
    };
  }
}
export async function runTriadPhase(mode, kind, offered, arrivalSpacingMs, env, runId) {
  if (!Number.isSafeInteger(offered) || offered < 1 || offered > 100)
    throw new RangeError("offered");
  if (!Number.isFinite(arrivalSpacingMs) || arrivalSpacingMs < 0) throw new RangeError("spacing");
  const began = performance.now(),
    rows = [],
    pending = new Set();
  for (let i = 0; i < offered; i++) {
    const scheduledAt = began + i * arrivalSpacingMs;
    await sleep(scheduledAt - performance.now());
    const launchDelayMs = performance.now() - scheduledAt;
    if (pending.size >= MAX_OUTSTANDING || launchDelayMs >= 100) {
      rows.push({
        status: 0,
        valid: false,
        launched: false,
        dropped: true,
        ms: performance.now() - scheduledAt,
        launchDelayMs,
      });
      continue;
    }
    const task = singleTriadProbe(mode, env, i, runId).then((result) => {
      rows.push({
        ...result,
        launched: true,
        dropped: false,
        launchDelayMs,
        ms: result.ms + launchDelayMs,
      });
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
  await Promise.allSettled([...pending]);
  return summarizeTriad(mode, kind, offered, rows, performance.now() - began);
}
export async function runTriadCampaign(env) {
  if (!triadStageBindingGuard(env)) throw new Error("stage-bindings-not-proven");
  const runId = crypto.randomUUID();
  const samples = [];
  // Interleave modes at each identical offered load to reduce temporal drift.
  // These are diagnostic probes, not 100-RPS production certificates.
  for (const offered of [1, 4, 8, 16, 24, 32]) {
    for (const mode of MODES) {
      const s = await runTriadPhase(mode, "burst-" + offered, offered, 0, env, runId);
      samples.push(s);
      console.log(JSON.stringify({ schema: "cove.triad-stage-phase.v1", ...s }));
    }
  }
  for (const rate of [10, 25]) {
    for (const mode of MODES) {
      const s = await runTriadPhase(
        mode,
        "scheduled-" + rate + "-rps",
        rate * 2,
        1000 / rate,
        env,
        runId,
      );
      samples.push(s);
      console.log(JSON.stringify({ schema: "cove.triad-stage-phase.v1", ...s }));
    }
  }
  const safe25 = samples.find((s) => s.kind === "scheduled-25-rps" && s.mode === "catalog");
  if (safe25 && safe25.valid === safe25.offered && safe25.dropped === 0 && safe25.p95Ms < 2000) {
    for (const mode of MODES) {
      const s = await runTriadPhase(mode, "scheduled-50-rps", 50, 20, env, runId);
      samples.push(s);
      console.log(JSON.stringify({ schema: "cove.triad-stage-phase.v1", ...s }));
    }
  }
  return {
    schema: "cove.triad-stage-campaign.v1",
    releaseCertified: false,
    syntheticD1: true,
    publicIngress: false,
    campaignCount: samples.length,
    rps50Eligible: Boolean(
      safe25 && safe25.valid === safe25.offered && safe25.dropped === 0 && safe25.p95Ms < 2000,
    ),
  };
}
export default {
  async fetch(request, env) {
    if (!triadStageBindingGuard(env)) return new Response(null, { status: 503 });
    // No public route, including to the diagnostic probes. Cron-only.
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  },
  async scheduled(event, env, ctx) {
    const expires = Date.parse(env.COVE_TRIAD_EXPIRES_AT || "");
    if (!triadStageBindingGuard(env) || !Number.isFinite(expires) || Date.now() > expires) return;
    ctx.waitUntil(runTriadCampaign(env).then((out) => console.log(JSON.stringify(out))));
  },
};
