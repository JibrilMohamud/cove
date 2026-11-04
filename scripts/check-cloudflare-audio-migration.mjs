/* eslint-disable prettier/prettier -- Explicit Cloudflare audio queue safety contract. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { audioDispatchKey, payloadForAudioPath, runtimeEnabled, validAudioMessage } from "../src/cloudflare-audio/contracts.mjs";

const read = (path) => readFileSync(path, "utf8");
const cfg = JSON.parse(read("wrangler.audio.cloudflare.jsonc"));
const backendCfg = read("wrangler.backend.production.toml");
const backend = read("src/persistence-backend.worker.ts");
const worker = read("src/cloudflare-audio/worker.mjs");
const python = read("scripts/audio_pipeline/cloudflare_service.py");
const docker = read("scripts/Dockerfile.cloudflare-audio");
const requirements = read("scripts/requirements.cloudflare-audio.txt");
const vercel = JSON.parse(read("vercel.json"));

const profiles = {
  "/api/fore/internal/ingestion/audio-scan": [undefined, 0, false, 2],
  "/api/fore/internal/ingestion/audio-discover": ["discover", 12, true, 2],
  "/api/fore/internal/ingestion/audio-track": ["track", 1, true, 2],
  "/api/fore/internal/ingestion/audio-align": ["align", 1, true, 4],
};
for (const [path, expected] of Object.entries(profiles)) {
  const job = payloadForAudioPath(path);
  assert.equal(job.kind, expected[0]);
  assert.equal(job.max_jobs, expected[1]);
  assert.equal(job.no_discovery, expected[2]);
  assert.equal(job.threads, expected[3]);
  assert.equal(job.minutes, 4);
  assert.equal(job.execution_mode, "direct");
  const key = await audioDispatchKey(path, 1_000_000);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, await audioDispatchKey(path, 1_100_000));
  assert.notEqual(key, await audioDispatchKey(path, 1_500_000));
  const msg = { v: 1, path, request: job, key };
  assert.equal(validAudioMessage(msg), true);
  assert.equal(validAudioMessage({ ...msg, request: { ...job, minutes: 99 } }), false);
  assert.equal(validAudioMessage({ ...msg, key: "wrong" }), false);
}
assert.equal(payloadForAudioPath("/api/fore/internal/ingestion/audio-payments"), null);
assert.equal(validAudioMessage({}), false);
await assert.rejects(audioDispatchKey("https://example.com"));
assert.equal(runtimeEnabled({ COVE_AUDIO_QUEUE_ENABLED: "1" }), true);
assert.equal(runtimeEnabled({ COVE_AUDIO_QUEUE_ENABLED: "0" }), false);
assert.equal(runtimeEnabled({}), false);

assert.equal(cfg.name, "cove-audio-pipeline-cloudflare");
assert.equal(cfg.workers_dev, false);
assert.equal(cfg.preview_urls, false);
assert.equal(cfg.vars.COVE_AUDIO_QUEUE_ENABLED, "0");
assert.equal(cfg.vars.FORE_BACKEND_URL, "https://api.covereads.com");
assert.equal(cfg.containers[0].scheduling_policy, "durable_object");
assert.equal(cfg.containers[0].images.base.dockerfile, "./scripts/Dockerfile.cloudflare-audio");
assert.equal(cfg.exports.CoveAudioContainer.storage, "sqlite");
assert.equal(cfg.exports.CoveAudioIdempotency.storage, "sqlite");
assert.deepEqual(cfg.queues.producers, [{ binding: "AUDIO_QUEUE", queue: "cove-audio-pipeline-v3" }]);
assert.equal(cfg.queues.consumers[0].queue, "cove-audio-pipeline-v3");
assert.equal(cfg.queues.consumers[0].dead_letter_queue, "cove-audio-pipeline-v3-dlq");
assert.equal(cfg.queues.consumers[0].max_batch_size, 1);
assert.equal(cfg.queues.consumers[0].max_concurrency, 1);
assert.ok(cfg.queues.consumers[0].max_retries > 10);
assert.ok(!cfg.d1_databases, "Audio coordinator cannot become a canonical D1 writer");
assert.ok(!cfg.routes && !cfg.route && !cfg.r2_buckets);
assert.ok(!/"(FORE_BACKEND_TOKEN|FORE_SERVICE_TOKEN|COVE_AUDIO_DISPATCH_SECRET|COVE_AUDIO_EXECUTION_SECRET)"\s*:/.test(JSON.stringify(cfg)));
assert.match(backendCfg, /\[\[services\]\]\nbinding = "COVE_AUDIO_DISPATCH"\nservice = "cove-audio-pipeline-cloudflare"/);
assert.match(backendCfg, /^COVE_AUDIO_PROVIDER = "legacy"$/m);
assert.match(backendCfg, /^FORE_AUDIO_COMPUTE_MODE = "paused"$/m);
assert.match(backend, /env\.COVE_AUDIO_PROVIDER === "cloudflare"/);
assert.match(backend, /COVE_AUDIO_DISPATCH\.fetch/);
assert.match(backend, /audioComputeAdmission\(env\)/);
assert.match(backend, /"x-cove-audio-dispatch-secret": env\.COVE_AUDIO_DISPATCH_SECRET/);
assert.doesNotMatch(backend, /triggerVercelAudio\(/);
assert.match(worker, /message\.ack\(\)/);
assert.match(worker, /message\.retry\(/);
for (const name of ["worker-complete", "worker-claim", "worker-release", "producer-claim", "COVE_AUDIO_EXECUTION_SECRET", "AUDIO_QUEUE"]) assert.ok(worker.includes(name));
assert.match(python, /hmac\.compare_digest/);
assert.match(python, /execute_pipeline/);
assert.match(python, /RunRequest\.model_validate/);
assert.match(docker, /python:3\.12-slim/);
assert.doesNotMatch(docker + requirements, /vercel.queue|vercel-queue|vercel\.app/);
assert.ok(vercel.services?.audio_pipeline, "Keep old audio until Cloudflare is certified");

await build({
  entryPoints: ["src/cloudflare-audio/worker.mjs"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  external: ["cloudflare:*"],
  write: false,
});
console.log("PASS: private Cloudflare audio Worker bundles; all four audio contracts, retries, DLQ and provider rollback are guarded.");
