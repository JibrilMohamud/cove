import {
  singleTriadProbe,
  triadStageBindingGuard,
  triadModes,
} from "./causal-triad-stage.worker.mjs";

const PREFIX = "/__cove/performance/triad/";
const MODES = new Set(triadModes);

function equalSecret(supplied, expected) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
  if (typeof supplied !== "string" || supplied.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++)
    mismatch |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

export function privateTriadGuard(env, request) {
  return (
    env?.COVE_TRIAD_ONDEMAND === "1" &&
    triadStageBindingGuard(env) &&
    Number.isFinite(Date.parse(env?.COVE_TRIAD_EXPIRES_AT || "")) &&
    Date.now() <= Date.parse(env.COVE_TRIAD_EXPIRES_AT) &&
    equalSecret(request.headers.get("x-cove-triad-key"), env.COVE_TRIAD_PROBE_GATE)
  );
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (request.method !== "GET" || !pathname.startsWith(PREFIX))
      return new Response(null, { status: 404 });
    if (!privateTriadGuard(env, request))
      return new Response(null, {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    const mode = pathname.slice(PREFIX.length);
    if (!MODES.has(mode)) return new Response(null, { status: 404 });
    const u = new URL(request.url);
    const ordinal = Number(u.searchParams.get("ordinal") ?? "0");
    const runId = u.searchParams.get("run") || "";
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal > 100000 ||
      !/^[a-z0-9-]{1,48}$/.test(runId)
    )
      return new Response(null, { status: 400 });
    const started = performance.now();
    const result = await singleTriadProbe(
      mode,
      env,
      ordinal,
      runId,
      mode === "r2cursor" ? request.headers.get("x-cove-stage-cursor") : null,
    );
    const duration = performance.now() - started;
    const payload = {
      mode,
      valid: Boolean(result.valid),
      downstreamStatus: result.status,
      workerDurationMs: Number(duration.toFixed(3)),
      d1SqlMs: Number.isFinite(result.sqlMs) ? result.sqlMs : null,
      d1OutsideSqlMs: Number.isFinite(result.outsideSqlMs) ? result.outsideSqlMs : null,
      downstreamFirstByteMs: Number.isFinite(result.firstByteMs) ? result.firstByteMs : null,
      stageR2Ms: Number.isFinite(result.stageR2Ms) ? result.stageR2Ms : null,
      stageCursorMs: Number.isFinite(result.stageCursorMs) ? result.stageCursorMs : null,
      stagePrimaryMs: Number.isFinite(result.stagePrimaryMs) ? result.stagePrimaryMs : null,
      stageAssemblyMs: Number.isFinite(result.stageAssemblyMs) ? result.stageAssemblyMs : null,
      resultKind: result.errorKind || null,
      ...(mode === "r2cursorseed" && result.valid && typeof result.cursorToken === "string"
        ? { cursorToken: result.cursorToken }
        : {}),
      releaseCertified: false,
    };
    return new Response(JSON.stringify(payload), {
      status: result.valid ? 200 : 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "server-timing": `cove_stage_worker;dur=${duration.toFixed(1)}`,
      },
    });
  },
};
