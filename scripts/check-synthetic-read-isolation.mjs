import assert from "node:assert/strict";
import { build } from "esbuild";
const output = await build({
  entryPoints: ["src/features/fore/synthetic-read-isolation.server.ts"],
  format: "esm",
  bundle: true,
  platform: "node",
  write: false,
});
const moduleUrl = "data:text/javascript;base64," + Buffer.from(output.outputFiles[0].contents).toString("base64");
const { syntheticPublicReadBucket: bucket, syntheticFailureCategory: failure } = await import(
  moduleUrl
);
const synthetic = {
  COVE_SSR_STAGING: "1",
  COVE_PERF_DATABASE_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
  COVE_PERF_EDGE_PUBLIC_READS: "1",
};
for (const [path, name] of [
  ["/api/fore/catalog", "catalog"],
  ["/api/fore/recommendations/home", "recommend-home"],
  ["/api/fore/merchandising", "merch"],
])
  assert.equal(bucket(synthetic, "GET", path, false, name), true);
for (const changed of [
  { COVE_SSR_STAGING: "0" },
  { COVE_PERF_DATABASE_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
  { COVE_PERF_EDGE_PUBLIC_READS: "0" },
  { COVE_PERF_DATABASE_ID: undefined },
]) {
  assert.equal(
    bucket({ ...synthetic, ...changed }, "GET", "/api/fore/catalog", false, "catalog"),
    false,
  );
}
assert.equal(bucket(synthetic, "POST", "/api/fore/catalog", false, "catalog"), false);
assert.equal(bucket(synthetic, "GET", "/api/fore/catalog", true, "catalog"), false);
assert.equal(bucket(synthetic, "GET", "/api/fore/checkout", false, "catalog"), false);
assert.equal(bucket(synthetic, "GET", "/api/fore/catalog", false, "search-click"), false);
assert.equal(failure(new Error("D1_ERROR: no such table: private")), "database-schema-or-statement");
assert.equal(failure(new Error("SQLITE_BUSY: queue")), "database-queue-or-overload");
assert.equal(failure(new Error("Timeout exceeded")), "dependency-timeout");
assert.equal(failure(new TypeError("Sensitive visitor info")), "runtime-type");
assert.equal(failure(new Error("token=SECRET")), "unknown");
console.log("Synthetic anonymous read isolation and sanitization gates: PASS");
