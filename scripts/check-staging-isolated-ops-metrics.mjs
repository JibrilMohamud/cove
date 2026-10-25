/* eslint-disable prettier/prettier -- Executable privacy and fail-closed fixture remains collocated. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";

const src = readFileSync("src/features/fore/anonymous-http-metric.server.ts", "utf8");
const cfg = readFileSync("wrangler.frontend.staging.toml", "utf8");
const production = readFileSync("wrangler.frontend.production.toml", "utf8");
assert.match(cfg, /\[\[analytics_engine_datasets\]\][\s\S]*?binding = "OPS_ANALYTICS"[\s\S]*?dataset = "cove_ops_anonymous_http_stage"/);
assert.match(cfg, /COVE_OPS_TELEMETRY_MODE = "analytics-engine"/);
assert.match(cfg, /COVE_SSR_STAGING = "1"/);
assert.doesNotMatch(production, /COVE_OPS_TELEMETRY_MODE\s*=\s*"analytics-engine"/);
const { code } = await transform(src, { loader: "ts", format: "esm" });
const { emitIsolatedAnonymousHttpMetric: emit } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

const points = [];
const stage = {
  COVE_SSR_STAGING: "1",
  COVE_OPS_TELEMETRY_MODE: "analytics-engine",
  OPS_ANALYTICS: { writeDataPoint: (point) => points.push(point) },
};
const req = (path, options = {}) => new Request(
  "https://cove-staging.example" + path, { method: options.method || "GET", headers: options.headers },
);
const res = (status = 200) => new Response("ok", { status });
assert.equal(emit(stage,req("/api/fore/catalog?email=private%40example.org"),res(),"anonymous",123),true);
assert.deepEqual(points[0],{
  blobs:["public-api-read","/api/fore/catalog","GET"],
  doubles:[200,123],
  indexes:["public-read"],
});
assert.equal(JSON.stringify(points).includes("private"),false);
assert.equal(points.length,1);
for (const request of [
  req("/api/fore/checkout/payment"),
  req("/api/fore/catalog",{ method:"POST" }),
  req("/api/fore/catalog",{headers:{cookie:"session=private"}}),
  req("/api/fore/catalog",{headers:{authorization:"Bearer private"}}),
  req("/api/fore/catalog",{headers:{"oai-authenticated-user-id":"private"}}),
  req("/api/fore/catalog",{headers:{"x-fore-authenticated-user-id":"private"}}),
]) assert.equal(emit(stage,request,res(),"anonymous",3),false);
for (const code of [201,400,401,403,404,429,500]) {
  const result=emit(stage,req("/api/fore/catalog"),res(code),"anonymous",3);
  assert.equal(result,code===201, "Non-2xx/unauthorized/error requests MUST stay on durable D1 auditing");
}
assert.equal(emit(stage,req("/api/fore/catalog"),res(),"user",3),false);
assert.equal(emit({...stage,COVE_SSR_STAGING:"0"},req("/api/fore/catalog"),res(),"anonymous",3),false);
assert.equal(emit({...stage,OPS_ANALYTICS:undefined},req("/api/fore/catalog"),res(),"anonymous",3),false);
assert.equal(emit({...stage,COVE_OPS_TELEMETRY_MODE:"d1"},req("/api/fore/catalog"),res(),"anonymous",3),false);
assert.equal(emit({...stage,OPS_ANALYTICS:{writeDataPoint:()=>{throw Error("fixture outage")}}},req("/api/fore/catalog"),res(),"anonymous",3),true,
  "An isolated-metrics outage must not become extra primary-D1 writes");
assert.ok(points.every(p=>p.blobs.length===3 && p.indexes[0]==="public-read"));
console.log("PASS: stage-only anonymous success metrics use isolated Analytics Engine; no PII, no commerce/security audit bypass");
