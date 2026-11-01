import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const worker = readFileSync("src/persistence-backend.worker.ts", "utf8");
const start = worker.indexOf("async function persistAudioTriggerDiagnostic(");
const end = worker.indexOf("async function triggerVercelAudio(", start);
assert.ok(start >= 0 && end > start);
const body = worker.slice(start, end);
assert.match(body, /reportAudioTriggerDiagnostic\(env, key, value\)/);
assert.doesNotMatch(body, /env\.DB|cove_runtime_config|\bINSERT\b|\bUPDATE\b/);
for (const kind of [
  "audio_trigger_last_error",
  "audio_trigger_last_success",
  "audio_trigger_last_timeout",
]) {
  assert.match(worker, new RegExp(kind));
}

const prod = readFileSync("wrangler.backend.production.toml", "utf8");
const deploy = readFileSync(".github/workflows/deploy-persistence-backend.yml", "utf8");
for (const config of [prod, deploy]) {
  assert.match(config, /binding = "BACKEND_DIAGNOSTICS"/);
  assert.match(config, /dataset = "cove_backend_audio_trigger_diagnostics"/);
}

const dir = mkdtempSync(path.join(tmpdir(), "cove-audio-trigger-metrics-"));
const previousInfo = console.info;
const previousWarn = console.warn;
try {
  const target = path.join(dir, "telemetry.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/backend-audio-trigger-diagnostics.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: target,
  });
  const { reportAudioTriggerDiagnostic } = await import(pathToFileURL(target).href);
  const info = [];
  const warnings = [];
  console.info = (...args) => info.push(args.join(" "));
  console.warn = (...args) => warnings.push(args.join(" "));

  const points = [];
  const env = {
    DB: {
      prepare() {
        throw Error("CANONICAL_D1_MUST_NOT_BE_TOUCHED");
      },
    },
    BACKEND_DIAGNOSTICS: {
      writeDataPoint(value) {
        points.push(value);
      },
    },
  };
  reportAudioTriggerDiagnostic(env, "audio_trigger_last_timeout", {
    path: "/api/fore/internal/ingestion/audio-align",
    status: 524,
    disposition: "in-flight",
    body: "SECRET_BEARER_NEVER_LOG",
  });
  assert.equal(points.length, 1);
  assert.deepEqual(points[0].indexes, ["audio_trigger_last_timeout"]);
  assert.deepEqual(points[0].blobs, ["/api/fore/internal/ingestion/audio-align", "in-flight"]);
  assert.equal(points[0].doubles[0], 524);
  assert.equal(typeof points[0].doubles[1], "number");
  const event = JSON.parse(info[0]);
  assert.equal(event.event, "cove_audio_trigger_diagnostic");
  assert.equal(event.status, 524);
  assert.ok(!JSON.stringify({ info, warnings, points }).includes("SECRET_BEARER_NEVER_LOG"));
  reportAudioTriggerDiagnostic({}, "audio_trigger_last_success", {
    path: "/api/fore/internal/ingestion/audio-track",
    status: 200,
  });
  assert.equal(JSON.parse(info[1]).status, 200);
  reportAudioTriggerDiagnostic(
    {
      BACKEND_DIAGNOSTICS: {
        writeDataPoint() {
          throw Error("metric unavailable");
        },
      },
    },
    "audio_trigger_last_error",
    { path: "https://bad.invalid/?secret=TOKEN", status: 403, body: "SECRET" },
  );
  assert.equal(JSON.parse(info[2]).path, "invalid_path");
  assert.equal(warnings.at(-1), "cove_audio_trigger_metrics_unavailable");
  assert.ok(!JSON.stringify({ info, warnings, points }).includes("TOKEN"));
  console.info = previousInfo;
  console.warn = previousWarn;
  console.log(
    "PASS: audio scheduler telemetry contains no secrets or canonical D1 writes, even during metrics outages.",
  );
} finally {
  console.info = previousInfo;
  console.warn = previousWarn;
  rmSync(dir, { recursive: true, force: true });
}
