// Never claim a particular server/network root cause from application I/O
// clocks alone. Diagnose only candidate fault domains; require platform
// CPU/wall-time correlations before asserting a causal explanation.
import fs from "node:fs";
import path from "node:path";

const label = {
  edge: "A: gated minimal Worker",
  d1: "B: minimal primary D1",
  rights: "C: live primary-rights shelf",
  bootstrap: "D: complete anonymous bootstrap",
  ssr: "E: production-equivalent full homepage SSR",
};
const asNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export function diagnoseAttribution(evidence, workerPlatform = {}) {
  const rows = evidence.summaries?.current || [];
  const find = (stage, concurrency = 8) =>
    rows.find((r) => r.stage === stage && r.concurrency === concurrency);
  const get = (stage) => asNumber(find(stage)?.latencyMs?.p95);
  const edge = get("edge");
  const d1 = get("d1");
  const rights = get("rights");
  const bootstrap = get("bootstrap");
  const ssr = get("ssr");
  const hypotheses = [];
  if ([edge, d1, rights, bootstrap, ssr].every((x) => x !== null)) {
    if (edge >= 650)
      hypotheses.push(
        "Minimal gated Worker requests also exceed 650 ms: investigate runner transport, edge routing, Worker initialization, and gate CPU before SQL.",
      );
    if (d1 - edge >= 150)
      hypotheses.push(
        "Minimal primary-D1 stage adds at least 150 ms at p95: investigate D1 service dispatch and connection to the primary (not necessarily SQL execution).",
      );
    if (rights - d1 >= 150)
      hypotheses.push(
        "Rights-bearing shelf is materially slower than a minimal D1 read: profile indexed legal candidate SQL, hydration, CPU, and D1 queue time.",
      );
    if (bootstrap - rights >= 150)
      hypotheses.push(
        "Bootstrap is materially slower than rights-only shelf: profile locale/market reads, limit checks and JSON processing.",
      );
    if (ssr - bootstrap >= 150)
      hypotheses.push(
        "Full SSR is materially slower than bootstrap: profile cold module initialization, TanStack rendering, serialization, and response handling.",
      );
  }
  const availableCfWorker = rows.some((r) => r.workerMetricCoverage > 0);
  const observedColos = [...new Set(rows.flatMap((r) => r.colos || []))];
  let nextAction =
    "insufficient evidence: repeat the diagnostic ladder with platform CPU/wall telemetry and a verified client-region probe";
  if (hypotheses.length)
    nextAction =
      "profile the flagged stages using Cloudflare platform CPU/wall traces and CPU profiling; do not infer causation by subtracting independent p95s";
  return {
    confidence: availableCfWorker
      ? "hypotheses-only; cfWorker partly available"
      : "hypotheses-only; cfWorker absent",
    status: evidence.allValid
      ? "diagnostic-complete-not-release-approved"
      : "diagnostic-invalid-retry-required",
    verifiedClientRegion: Boolean(evidence.clientRegionVerified),
    matchedColos: Boolean(evidence.matchedColos),
    observedColos,
    cfWorkerPresent: availableCfWorker,
    platformTelemetry: Object.fromEntries(
      Object.entries(workerPlatform).map(([role, row]) => [
        role,
        "warning" in (row || {})
          ? row.warning
          : "sampled invocations, not per-response attribution",
      ]),
    ),
    hypotheses: hypotheses.length
      ? hypotheses
      : ["No unique bottleneck identified from available sampled stage timings."],
    nextAction,
    rootCauseProven: false,
  };
}
function number(v) {
  return v === null || v === undefined ? "n/a" : Math.round(v) + " ms";
}
function table(role, evidence) {
  const rows = evidence.summaries[role];
  return [
    "| Stage | Concurrency | Valid | p50 | p95 | Max | cfWorker p95 | D1 SQL p95 | Serial handshake p95* | Colos |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...rows.map((r) =>
      [
        label[r.stage],
        r.concurrency,
        `${r.valid}/${r.requested}`,
        number(r.latencyMs?.p50),
        number(r.latencyMs?.p95),
        number(r.latencyMs?.max),
        number(r.cfWorkerMs?.p95),
        number(r.sqlMs?.p95),
        number(r.serialHandshakeMs?.p95),
        (r.colos || []).join(", "),
      ]
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    ),
  ].join("\n");
}
export function writeAttributionReport(evidence, { root, workerPlatform, revision } = {}) {
  const outDir = root || process.cwd();
  fs.mkdirSync(outDir, { recursive: true });
  const diagnostic = diagnoseAttribution(evidence, workerPlatform);
  const md = [
    "# Cove — protected identical-code latency attribution",
    "",
    "## Experiment identity and validity",
    "",
    `- Same exact immutable instrumented SHA in both cohorts: \`${revision?.current || "unverified"}\``,
    "- Protected synthetic-only D1, 50,000 catalog items with real negative/revoked grants.",
    "- The five stages are **different request paths**, not mutually exclusive additives.",
    `- Samples valid: **${evidence.allValid ? "yes" : "NO"}**; matched colos: **${evidence.matchedColos ? "yes" : "NO"}**.`,
    `- Client region: \`${evidence.clientRegion}\` (verified: ${evidence.clientRegionVerified}).`,
    "- **Fresh deployment and first-cold SSR** measured separately by the original protected 3-round benchmark; A–E ladders are warm post-deployment diagnostics.",
    "- Rates here are **not** production SLO qualification and do not measure all world regions.",
    "",
    "## Identical Worker — synthetic control DB",
    table("baseline", evidence),
    "",
    "## Identical Worker — synthetic candidate DB",
    table("current", evidence),
    "",
    "## Root-cause hypothesis (not proof)",
    ...diagnostic.hypotheses.map((x) => "- " + x),
    "",
    `Confidence: ${diagnostic.confidence}.`,
    `Next action: ${diagnostic.nextAction}.`,
    "",
    "## Cautions and telemetry gaps",
    "",
    "- Cloudflare Worker JavaScript timers can pause during CPU work; cove_total is NOT full Worker CPU/wall time.",
    "- cfWorker is an independent platform timing when available; missing means unknown, not zero.",
    "- SQL duration excludes D1 dispatch, service queue, transport, and Worker code.",
    "- *Combined DNS+TCP+TLS connection duration is recorded only for a sole in-flight request with corresponding Undici connect events; under concurrent pooled fetches, handshake attribution is unavailable (shown n/a).",
    "- Undici create/send/headers separately measures client queue and time from headers sent to first response headers; neither is Worker-only latency.",
    "- Comparisons of p95 from separate requests cannot be subtracted to prove per-stage duration or root cause.",
    "- Platform Workers CPU/wall quantiles are sampled per script and include controls; do not assert per-homepage attribution.",
    "- The full SSR release gate and live territory rights remain independent and mandatory.",
    "",
    "## Paired colo overlaps",
    ...evidence.overlap.map(
      (r) => `- ${r.stage}/${r.concurrency}: ${r.sharedColos.join(", ") || "UNMATCHED"}`,
    ),
    "",
  ].join("\n");
  const jsonFile = path.join(outDir, "latency-attribution.json");
  const mdFile = path.join(outDir, "latency-attribution.md");
  const csvFile = path.join(outDir, "latency-attribution.csv");
  fs.writeFileSync(jsonFile, JSON.stringify({ evidence, diagnostic, revision }, null, 2) + "\n");
  fs.writeFileSync(mdFile, md + "\n");
  const records = [
    "cohort,stage,concurrency,requested,valid,p50_ms,p95_ms,max_ms,cfworker_p95_ms,sql_p95_ms,serial_handshake_p95_ms,colo",
  ];
  for (const role of ["baseline", "current"])
    for (const row of evidence.summaries[role])
      records.push(
        [
          role,
          row.stage,
          row.concurrency,
          row.requested,
          row.valid,
          row.latencyMs?.p50 ?? "",
          row.latencyMs?.p95 ?? "",
          row.latencyMs?.max ?? "",
          row.cfWorkerMs?.p95 ?? "",
          row.sqlMs?.p95 ?? "",
          row.serialHandshakeMs?.p95 ?? "",
          row.colos?.join(" ") || "",
        ].join(","),
      );
  fs.writeFileSync(csvFile, records.join("\n") + "\n");
  return { jsonFile, mdFile, csvFile, diagnostic };
}
