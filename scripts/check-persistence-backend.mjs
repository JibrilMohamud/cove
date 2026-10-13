import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");

const [
  server,
  gateway,
  worker,
  pipeline,
  runner,
  media,
  service,
  audioWorker,
  audioSubscriber,
  aligner,
  audioPyproject,
  vercelRaw,
  packageRaw,
  wrangler,
  deployWorkflow,
  audioDockerfile,
] = await Promise.all([
  read("src/server.ts"),
  read("src/lib/persistence-backend.ts"),
  read("src/persistence-backend.worker.ts"),
  read("src/features/fore/pipeline.server.ts"),
  read("scripts/audio_pipeline/runner.py"),
  read("scripts/audio_pipeline/media.py"),
  read("scripts/audio_pipeline/service.py"),
  read("scripts/audio_pipeline/worker.py"),
  read("scripts/audio_pipeline/subscriber.py"),
  read("scripts/audio_pipeline/align.py"),
  read("scripts/pyproject.toml"),
  read("vercel.json"),
  read("package.json"),
  read("wrangler.backend.example.toml"),
  read(".github/workflows/deploy-persistence-backend.yml"),
  read("scripts/Dockerfile.vercel"),
]);

const vercel = JSON.parse(vercelRaw);
const pkg = JSON.parse(packageRaw);

assert.match(server, /handleVercelIngestionControl/);
assert.match(server, /proxyPersistenceApi/);
assert.ok(
  server.indexOf("proxyPersistenceApi") < server.indexOf("handleCoveApi(request"),
  "persistent gateway must run before the stateless fallback API",
);

assert.match(gateway, /FORE_BACKEND_URL/);
assert.match(gateway, /FORE_BACKEND_TOKEN/);
assert.match(gateway, /x-vercel-ip-country/);
assert.match(gateway, /x-cove-client-country/);
assert.match(gateway, /x-cove-client-ip/);
assert.match(gateway, /startsWith\("cf-"\)/);
assert.doesNotMatch(gateway, /headers\.set\("cf-(?:ipcountry|connecting-ip)"/);
assert.match(gateway, /safePublicFallback/);
assert.match(gateway, /COVE_AUDIO_PIPELINE_URL/);
assert.match(gateway, /CRON_SECRET/);
assert.match(gateway, /FORE_INGESTION_VERIFY_JWK/);
assert.match(gateway, /x-cove-ingestion-signature/);
assert.match(gateway, /ECDSA/);
assert.doesNotMatch(gateway, /\bas any\b/);

assert.match(worker, /x-cove-backend-token/);
assert.doesNotMatch(worker, /\bas any\b/);
assert.match(worker, /safeEqual/);
assert.match(worker, /FORE_BACKEND_TOKEN_SHA256/);
assert.match(worker, /FORE_INGESTION_SIGNING_KEY/);
assert.match(worker, /x-cove-ingestion-signature/);
assert.match(worker, /ECDSA/);
assert.match(worker, /caches\?\.default|caches\?\.default/);
const cache = await read("src/features/fore/public-api-cache.server.ts");
assert.match(cache, /__cove_country/);
assert.match(cache, /__cove_language/);
assert.match(cache, /"cache-control", "no-store"/);
assert.match(worker, /runCatalogIngestion/);
assert.match(worker, /__cove\/ingestion\/catalog/);

assert.match(pipeline, /z\.enum\(\[\s*["']discover["'],\s*["']track["'],\s*["']align["']\s*\]\)/);
assert.match(pipeline, /10\s*\*\s*60000/);
assert.match(pipeline, /alignmentQueued/);
assert.match(pipeline, /align-\$\{e\.id\}-\$\{t\.id\}/);

const trackStart = runner.indexOf("def process_track");
const alignStart = runner.indexOf("def process_alignment");
assert.ok(trackStart >= 0 && alignStart > trackStart);
const trackBody = runner.slice(trackStart, alignStart);
assert.doesNotMatch(trackBody, /transcribe\(/);
assert.match(trackBody, /pipeline\/media/);
const alignBody = runner.slice(alignStart, runner.indexOf("def process(", alignStart));
assert.match(alignBody, /transcribe\(/);
assert.match(alignBody, /pipeline\/alignment/);
assert.match(runner, /choices=\['discover','track','align'\]/);
assert.match(runner, /stop\.wait\(120\)/);
assert.match(media, /file\.unlink\(missing_ok=True\)/);
assert.match(media, /parts\.rmdir\(\)/);
assert.ok(
  media.indexOf("file.unlink(missing_ok=True)") < media.indexOf("temporary.replace(target)"),
  "range files must be released before the reconstructed file is promoted",
);

assert.match(audioWorker, /Literal\["discover", "track", "align"\]/);
assert.match(audioWorker, /execution_mode: Literal\["inherit", "direct", "queue"\]/);
assert.match(audioWorker, /ge=0/);
assert.match(audioWorker, /le=5/);
assert.match(audioWorker, /cove-audio-pipeline-v2/);
assert.match(audioWorker, /RUN_ROOT = pathlib\.Path\("\/tmp\/cove-audio-runs"\)/);
assert.match(audioWorker, /RDF_CACHE = pathlib\.Path\("\/tmp\/cove-rdf-cache"\)/);
assert.match(audioWorker, /MODEL_CACHE = pathlib\.Path\("\/tmp\/cove-model-cache"\)/);
assert.match(audioWorker, /RUNTIME_HOME = pathlib\.Path\("\/tmp\/cove-runtime-home"\)/);
assert.match(audioWorker, /HF_HOME = pathlib\.Path\("\/tmp\/cove-huggingface"\)/);
assert.match(audioWorker, /os\.environ\["HOME"\] = str\(RUNTIME_HOME\)/);
assert.match(audioWorker, /os\.environ\["HF_HOME"\] = str\(HF_HOME\)/);
assert.match(audioWorker, /os\.environ\["HF_HUB_DISABLE_XET"\] = "1"/);
assert.match(audioWorker, /os\.environ\["HF_HUB_CACHE"\]/);
assert.match(audioWorker, /os\.environ\["NUMBA_CACHE_DIR"\]/);
assert.match(audioWorker, /STALE_RUN_SECONDS = 6 \* 60/);
assert.match(audioWorker, /for path in \(RUNTIME_HOME, HF_HOME\)/);
assert.match(audioWorker, /tempfile\.mkdtemp/);
assert.match(audioWorker, /shutil\.rmtree\(cache, ignore_errors=True\)/);
assert.match(audioWorker, /def _disk_snapshot\(\)/);
assert.match(audioWorker, /Cove audio pipeline disk before/);
assert.match(audioWorker, /Cove audio pipeline disk after/);
assert.match(service, /from vercel\.queue import QueueClient/);
assert.doesNotMatch(service, /ALL_DEPLOYMENTS/);
assert.match(
  service,
  /queue = QueueClient\(region=os\.environ\.get\("COVE_AUDIO_QUEUE_REGION", "iad1"\)\)/,
);
assert.match(service, /execution_mode/);
assert.match(service, /COVE_AUDIO_EXECUTION_MODE/);
assert.match(
  service,
  /request\.execution_mode if request\.execution_mode != "inherit" else execution_mode\(\)/,
);
assert.match(service, /asyncio\.to_thread\(execute_pipeline, request\)/);
assert.match(service, /queueMode": "push"/);
assert.doesNotMatch(service, /poll_and_handle/);
assert.doesNotMatch(service, /lifespan=/);
assert.match(audioSubscriber, /@subscribe\(/);
assert.match(audioSubscriber, /AUDIO_TRIGGER_TOPIC/);
assert.match(audioSubscriber, /max_concurrency=2/);
assert.match(audioPyproject, /entrypoint = "audio_pipeline\.subscriber"/);
assert.match(audioSubscriber, /max_attempts=8/);
assert.match(audioSubscriber, /Message\[dict\[str, object\]\]/);
assert.match(audioPyproject, /\[tool\.vercel\]/);
assert.match(audioPyproject, /entrypoint = "audio_pipeline\.service:app"/);
assert.match(audioPyproject, /\[\[tool\.vercel\.subscribers\]\]/);
assert.match(audioPyproject, /topics = \["cove-audio-pipeline-v2"\]/);
assert.match(audioPyproject, /entrypoint = "audio_pipeline\.subscriber"/);

assert.equal(vercel.services.app.framework, "tanstack-start");
assert.equal(vercel.services.audio_pipeline.root, "scripts");
assert.equal(vercel.services.audio_pipeline.framework, "fastapi");
assert.equal(
  vercel.services.audio_pipeline.functions["audio_pipeline/service.py"].maxDuration,
  300,
);
assert.equal(
  vercel.services.audio_pipeline.functions["audio_pipeline/subscriber.py"].maxDuration,
  300,
);
assert.equal(vercel.services.audio_pipeline.runtime, undefined);
assert.equal(vercel.services.audio_pipeline.entrypoint, undefined);
assert.match(audioDockerfile, /FROM python:3\.12-slim/);
assert.match(audioDockerfile, /libgomp1/);
assert.ok(
  vercel.services.app.bindings.some(
    (x) => x.service === "audio_pipeline" && x.env === "COVE_AUDIO_PIPELINE_URL",
  ),
);
assert.equal(vercel.services.audio_pipeline.bindings, undefined);
assert.match(runner, /x-cove-backend-token/);
assert.match(runner, /FORE_BACKEND_URL/);

assert.equal(
  vercel.crons,
  undefined,
  "frequent ingestion must not depend on Vercel plan-specific cron intervals",
);
assert.match(worker, /async scheduled/);
assert.match(worker, /FORE_INGESTION_TRIGGER_TOKEN/);
assert.match(worker, /audio_trigger_last_timeout/);
assert.match(worker, /response\.status === 524/);
assert.doesNotMatch(worker, /FORE_AUDIO_TRACK_DIRECT_URL/);
assert.doesNotMatch(worker, /FORE_AUDIO_ALIGN_DIRECT_URL/);
assert.match(worker, /new URL\(path, env\.FORE_PUBLIC_URL\)/);
for (const cron of ["*/5 * * * *", "*/10 * * * *", "2-59/5 * * * *", "17 3 * * *", "41 4 * * *"]) {
  assert.ok(wrangler.includes(cron), "missing backend Worker cron " + cron);
}
assert.match(wrangler, /FORE_INGESTION_SIGNING_KEY/);
assert.doesNotMatch(wrangler, /FORE_BACKEND_TOKEN\s*$/m);

assert.match(deployWorkflow, /cloudflare\/wrangler-action@v4/);
assert.match(deployWorkflow, /d1 migrations apply DB --remote/);
assert.match(deployWorkflow, /FORE_INGESTION_SIGNING_KEY/);
assert.doesNotMatch(deployWorkflow, /^\s*FORE_BACKEND_TOKEN\s*$/m);
assert.doesNotMatch(deployWorkflow, /^\s*FORE_INGESTION_TRIGGER_TOKEN\s*$/m);
assert.match(deployWorkflow, /database_id = "\$D1_DATABASE_ID"/);
assert.match(deployWorkflow, /bucket_name = "\$R2_BUCKET_NAME"/);
assert.match(deployWorkflow, /npm run build:backend/);

// Audio/BioSync runtime compatibility contract.
const audioRequirements = await read("scripts/audio_pipeline/requirements.txt");
const audioPyprojectText = audioPyproject;
assert.match(audioRequirements, /^faster-whisper==1\.2\.1$/m);
assert.match(audioRequirements, /^av>=11,<19$/m);
assert.match(audioPyprojectText, /"av>=11,<19"/);
assert.match(aligner, /metadata_errors/);
assert.match(aligner, /retry\.pop\('metadata_errors',None\)/);
assert.match(audioWorker, /RUN_ROOT = pathlib\.Path\("\/tmp\/cove-audio-runs"\)/);
assert.match(audioWorker, /tempfile\.tempdir = str\(RUN_ROOT\)/);
assert.match(audioWorker, /os\.environ\["HF_HOME"\] = str\(HF_HOME\)/);
assert.match(
  gateway,
  /"\/api\/fore\/internal\/ingestion\/audio-align":[\s\S]*?execution_mode:\s*"direct"[\s\S]*?threads:\s*4/,
);
assert.match(
  gateway,
  /"\/api\/fore\/internal\/ingestion\/audio-track":[\s\S]*?execution_mode:\s*"direct"/,
);
assert.match(
  gateway,
  /"\/api\/fore\/internal\/ingestion\/audio-discover":[\s\S]*?execution_mode:\s*"direct"/,
);
assert.match(worker, /audioAlignmentTriggerSlots/);
assert.match(worker, /alignmentState\.slots > 0/);
assert.match(worker, /cron === "2-59\/5 \* \* \* \*"/);

assert.equal(pkg.scripts["build:backend"], "node scripts/build-persistence-backend.mjs");
console.log("Persistent backend architecture checks passed.");
