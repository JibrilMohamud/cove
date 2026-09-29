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
  vercelRaw,
  packageRaw,
  wrangler,
] = await Promise.all([
  read("src/server.ts"),
  read("src/lib/persistence-backend.ts"),
  read("src/persistence-backend.worker.ts"),
  read("src/features/fore/pipeline.server.ts"),
  read("scripts/audio_pipeline/runner.py"),
  read("scripts/audio_pipeline/service.py"),
  read("vercel.json"),
  read("package.json"),
  read("wrangler.backend.example.toml"),
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
assert.match(gateway, /cf-ipcountry/);
assert.match(gateway, /safePublicFallback/);
assert.match(gateway, /COVE_AUDIO_PIPELINE_URL/);
assert.match(gateway, /CRON_SECRET/);

assert.match(worker, /x-cove-backend-token/);
assert.match(worker, /safeEqual/);
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

assert.match(service, /Literal\["discover", "track", "align"\]/);
assert.match(service, /ge=0/);

assert.equal(vercel.services.app.framework, "tanstack-start");
assert.equal(vercel.services.audio_pipeline.root, "scripts");
assert.equal(vercel.services.audio_pipeline.framework, "fastapi");
assert.equal(vercel.services.audio_pipeline.functions["**/*.py"].maxDuration, 300);
assert.ok(
  vercel.services.app.bindings.some(
    (x) => x.service === "audio_pipeline" && x.env === "COVE_AUDIO_PIPELINE_URL",
  ),
);
assert.ok(
  vercel.services.audio_pipeline.bindings.some(
    (x) => x.service === "app" && x.env === "COVE_APP_INTERNAL_URL",
  ),
);

assert.equal(vercel.crons, undefined, "frequent ingestion must not depend on Vercel plan-specific cron intervals");
assert.match(worker, /async scheduled/);
assert.match(worker, /FORE_INGESTION_TRIGGER_TOKEN/);
for (const cron of ["*/5 * * * *", "*/10 * * * *", "23 * * * *", "17 3 * * *", "41 4 * * *"]) {
  assert.ok(wrangler.includes(cron), "missing backend Worker cron " + cron);
}
assert.match(wrangler, /FORE_INGESTION_TRIGGER_TOKEN/);

assert.equal(pkg.scripts["build:backend"], "node scripts/build-persistence-backend.mjs");
console.log("Persistent backend architecture checks passed.");
