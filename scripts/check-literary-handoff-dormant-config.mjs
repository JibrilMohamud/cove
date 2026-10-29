import assert from "node:assert/strict";
import fs from "node:fs";

const raw = fs.readFileSync("wrangler.content-literary-handoff.prod-disabled.jsonc", "utf8");
const cfg = JSON.parse(raw);
assert.equal(cfg.name, "cove-literary-handoff-isolated-disabled");
assert.equal(cfg.workers_dev, false);
assert.equal(cfg.preview_urls, false);
assert.equal(cfg.main, "content-dist/worker.js");
assert.ok(
  !cfg.d1_databases.some((x) => x.binding === "DB"),
  "Disabled handoff must not regain primary D1",
);
assert.deepEqual(
  cfg.d1_databases.map((x) => x.database_id),
  ["400c3af3-5d40-41fd-83cc-98228e40ddac"],
);
assert.deepEqual(
  cfg.r2_buckets.map((x) => x.bucket_name),
  ["cove-literary-originals-isolated-20261024"],
);
assert.ok(!cfg.routes && !cfg.route && !cfg.triggers && !cfg.queues);
assert.equal(cfg.vars.FORE_CONTENT_PROCESSOR_ROLE, "literary-handoff");
for (const key of [
  "FORE_CONTENT_PROCESSOR_ENABLED",
  "FORE_CONTENT_PREPARE_ENABLED",
  "FORE_CONTENT_HANDOFF_ENABLED",
  "FORE_LITERARY_DRAIN_RECONCILE_ENABLED",
])
  assert.equal(cfg.vars[key], "0");
const workflow = fs.readFileSync(
  ".github/workflows/literary-prod-handoff-dormant-deploy.yml",
  "utf8",
);
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
assert.ok(workflow.includes("github.event_name == 'push'"));
assert.ok(workflow.includes("cancel-in-progress: false"));
assert.ok(workflow.includes("node scripts/staging/deploy-literary-handoff-disabled.mjs"));
assert.ok(!workflow.includes("github.event.pull_request.head.ref =="));
for (const [file, role] of [
  ["wrangler.content-literary-prepare.prod-disabled.jsonc", "literary-prepare"],
  ["wrangler.content-literary-infer.prod-disabled.jsonc", "literary-infer"],
]) {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.ok(!cfg.routes && !cfg.route && !cfg.triggers && !cfg.queues);
  assert.equal(cfg.vars.FORE_CONTENT_PROCESSOR_ROLE, role);
  assert.equal(cfg.vars.FORE_CONTENT_PROCESSOR_ENABLED, "0");
  assert.equal(cfg.vars.FORE_CONTENT_PREPARE_ENABLED, "0");
  assert.deepEqual(
    cfg.d1_databases.map((x) => x.database_id),
    role === "literary-prepare"
      ? ["400c3af3-5d40-41fd-83cc-98228e40ddac"]
      : ["4bd657ac-8789-403e-a28c-93aba8d0a989", "400c3af3-5d40-41fd-83cc-98228e40ddac"],
  );
  assert.deepEqual(
    cfg.r2_buckets.map((x) => x.bucket_name),
    role === "literary-prepare"
      ? ["cove-literary-originals-isolated-20261024", "cove-production-media"]
      : ["cove-literary-originals-isolated-20261024"],
  );
  if (role === "literary-prepare")
    assert.ok(
      !cfg.d1_databases.some((x) => x.binding === "DB"),
      "Disabled prepare must not regain primary D1",
    );
  if (role === "literary-infer") {
    assert.equal(cfg.vars.FORE_CONTENT_INFERENCE_ENABLED, "0");
    assert.equal(cfg.ai.binding, "AI");
    assert.deepEqual(cfg.services, [
      { binding: "LITERARY_PUBLISHER", service: "cove-literary-publisher-isolated-disabled" },
    ]);
  }
}
console.log(
  "LITERARY_DORMANT_CONFIG_PASS no public route, cron, queue, owner flip or processing permission",
);
