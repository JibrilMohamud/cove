import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");

const [
  server,
  gateway,
  worker,
  pipeline,
  runner,
  service,
  audioWorker,
  audioSubscriber,
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
  read("scripts/audio_pipeline/service.py"),
  read("scripts/audio_pipeline/worker.py"),
  read("scripts/audio_pipeline/subscriber.py"),
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
assert.match(worker, /__cove_country/);
assert.match(worker, /__cove_language/);
assert.match(worker, /"cache-control", "no-store"/);
assert.match(worker, /runCatalogIngestion/);
assert.match(worker, /__cove\/ingestion\/catalog/);

assert.match(pipeline, /z\.enum\(\['discover','track','align'\]\)/);
assert.match(pipeline, /10\*60000/);
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

assert.match(audioWorker, /Literal\["discover", "track", "align"\]/);
assert.match(audioWorker, /ge=0/);
assert.match(audioWorker, /le=5/);
assert.match(audioWorker, /cove-audio-pipeline-v2/);
assert.match(service, /QueueClient\(\)/);
assert.match(service, /queueMode": "push"/);
assert.doesNotMatch(service, /poll_and_handle/);
assert.doesNotMatch(service, /lifespan=/);
assert.match(audioSubscriber, /@subscribe\(/);
assert.match(audioSubscriber, /AUDIO_TRIGGER_TOPIC/);
assert.match(audioSubscriber, /max_concurrency=1/);
assert.match(audioSubscriber, /max_attempts=8/);
assert.match(audioSubscriber, /Message\[dict\[str, object\]\]/);
assert.match(audioPyproject, /\[tool\.vercel\]/);
assert.match(audioPyproject, /entrypoint = "audio_pipeline\.service:app"/);
assert.match(audioPyproject, /\[\[tool\.vercel\.subscribers\]\]/);
assert.match(audioPyproject, /entrypoint = "audio_pipeline\.subscriber"/);

assert.equal(vercel.services.app.framework, "tanstack-start");
assert.equal(vercel.services.audio_pipeline.root, "scripts");
assert.equal(vercel.services.audio_pipeline.framework, "fastapi");
assert.equal(vercel.services.audio_pipeline.runtime, undefined);
assert.equal(vercel.services.audio_pipeline.entrypoint, undefined);
assert.equal(vercel.services.audio_pipeline.functions, undefined);
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

assert.equal(vercel.crons, undefined, "frequent ingestion must not depend on Vercel plan-specific cron intervals");
assert.match(worker, /async scheduled/);
assert.match(worker, /FORE_INGESTION_TRIGGER_TOKEN/);
for (const cron of ["*/5 * * * *", "*/10 * * * *", "23 * * * *", "17 3 * * *", "41 4 * * *"]) {
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

assert.equal(pkg.scripts["build:backend"], "node scripts/build-persistence-backend.mjs");
console.log("Persistent backend architecture checks passed.");
