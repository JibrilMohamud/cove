import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, {
  triadStageBindingGuard, triadModes, triadSql, stageSyntheticIp,
  singleTriadProbe, summarizeTriad, runTriadPhase,
} from "./causal-triad-stage.worker.mjs";

const config = JSON.parse(readFileSync("wrangler.performance-triad.stage.jsonc", "utf8"));
const TEST_DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const env = {
  COVE_TRIAD_STAGE: "1", COVE_TRIAD_SYNTHETIC_D1_ID: TEST_DB,
  COVE_TRIAD_CANDIDATE: "cove-presentation-r2-candidate-stage",
  BACKEND: "b".repeat(64), GATE: "a".repeat(64),
  DB: { prepare: (sql) => ({
    bind: (...args) => {
      assert.equal(sql, triadSql);
      assert.deepEqual(args, ["available", "US", "USD", 25]);
      return { all: async () => ({
        results: Array.from({ length: 25 }, (_, i) => ({ product_id: "perf-synth-" + i })),
        meta: { duration: 1 },
      }) };
    },
  }) },
  CANDIDATE: { fetch: async (request) => {
    assert.equal(request.headers.get("x-cove-backend-token"), "b".repeat(64));
    assert.equal(request.headers.get("x-cove-client-country"), "US");
    assert.match(request.headers.get("x-cove-client-ip"), /^192\.0\.2\.\d+$/);
    assert.equal(request.headers.get("cookie"), null);
    return Response.json({
      results: Array.from({ length: 24 }, (_, i) => ({ productId: "perf-synth-" + i })),
    }, { headers: { "x-cove-persistence": "d1-r2" } });
  }},
};
test("staging is private, read-only, and not bound to production", () => {
  assert.equal(config.name, "cove-presentation-capacity-driver-stage");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.d1_databases.map((d) => d.database_id), [TEST_DB]);
  assert.deepEqual(config.services, [{ binding: "CANDIDATE", service: "cove-presentation-r2-candidate-stage" }]);
  for (const denied of ["routes", "r2_buckets", "kv_namespaces", "durable_objects", "triggers"])
    assert.equal(config[denied], undefined);
  assert.equal(config.vars.COVE_TRIAD_EXPIRES_AT, "1970-01-01T00:00:00Z");
  assert.equal(triadStageBindingGuard(env), true);
  assert.equal(triadStageBindingGuard({ ...env, COVE_TRIAD_STAGE: "0" }), false);
  assert.equal(triadStageBindingGuard({ ...env, COVE_TRIAD_SYNTHETIC_D1_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" }), false);
  assert.deepEqual(triadModes, ["noop","rights","catalog"]);
  assert.match(triadSql, /retail_product_availability_rows/);
  assert.match(triadSql, /INDEXED BY idx_search_popular_stable/);
});
test("all paths validate stage identity and independent rights provenance", async () => {
  assert.equal((await singleTriadProbe("noop",env,0,"probe")).valid,true);
  const rights=await singleTriadProbe("rights",env,1,"probe");
  assert.equal(rights.valid,true);
  assert.equal(rights.sqlMs,1);
  const full=await singleTriadProbe("catalog",env,2,"probe");
  assert.equal(full.valid,true);
  assert.equal(full.status,200);
  const den=await worker.fetch(new Request("https://triad.invalid/api/fore/catalog"),env);
  assert.equal(den.status,404);
  assert.equal((await worker.fetch(new Request("https://triad.invalid"),{...env,BACKEND:undefined})).status,503);
});
test("summarization counts every failure and does not imply a release pass", () => {
  const s=summarizeTriad("catalog","burst-4",4,[
    {ms:10,valid:true,status:200,launched:true},
    {ms:20,valid:true,status:200,launched:true},
    {ms:200,valid:false,status:503,launched:true},
    {ms:300,valid:false,status:0,launched:false,dropped:true,launchDelayMs:100},
  ],400);
  assert.equal(s.offered,4);
  assert.equal(s.valid,2);
  assert.equal(s.failed,2);
  assert.equal(s.dropped,1);
  assert.equal(s.p95Ms,300);
  assert.equal(s.releaseCertified,false);
  assert.equal(s.statusCounts["503"],1);
});
test("scheduler and synthetic distributed clients retain bounded, valid results", async () => {
  assert.equal(stageSyntheticIp(0),"192.0.2.1");
  assert.equal(stageSyntheticIp(250),"192.0.2.1");
  assert.throws(()=>stageSyntheticIp(-1),RangeError);
  const s=await runTriadPhase("rights","burst-1",1,0,env,"test");
  assert.equal(s.offered,1);
  assert.equal(s.valid,1);
  assert.equal(s.dropped,0);
  assert.equal(s.releaseCertified,false);
  await assert.rejects(()=>runTriadPhase("rights","bad",101,0,env,"test"),RangeError);
});
