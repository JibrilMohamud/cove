import assert from "node:assert/strict";
import { build } from "esbuild";

const output = await build({
  entryPoints: ["src/features/fore/telemetry-isolation.server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const moduleUrl =
  "data:text/javascript;base64," + Buffer.from(output.outputFiles[0].contents).toString("base64");
const { shouldUseConsoleOnlyHttpTelemetry: skipD1 } = await import(moduleUrl);

const fixture = {
  COVE_SSR_STAGING: "1",
  COVE_PERF_DATABASE_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
  COVE_PERF_TELEMETRY_MODE: "console-only",
};
const make = (path, options = {}) => new Request("https://synthetic.invalid" + path, options);
for (const route of [
  "/api/fore/catalog?search=Test",
  "/api/fore/recommendations/home?visitor=fixed",
  "/api/fore/merchandising?visitor=fixed",
]) {
  assert.equal(skipD1(fixture, make(route), 200, false), true);
  assert.equal(skipD1(fixture, make(route), 200, true), false);
  for (const status of [201, 302, 401, 403, 404, 429, 500, 503])
    assert.equal(skipD1(fixture, make(route), status, false), false);
  for (const header of [
    "authorization",
    "cookie",
    "oai-authenticated-user-id",
    "oai-authenticated-user-email",
    "x-fore-authenticated-user-id",
  ]) {
    assert.equal(
      skipD1(fixture, make(route, { headers: { [header]: "present" } }), 200, false),
      false,
    );
  }
  assert.equal(skipD1({ ...fixture, COVE_SSR_STAGING: "0" }, make(route), 200, false), false);
  assert.equal(
    skipD1(
      { ...fixture, COVE_PERF_DATABASE_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
      make(route),
      200,
      false,
    ),
    false,
  );
  assert.equal(
    skipD1({ ...fixture, COVE_PERF_TELEMETRY_MODE: undefined }, make(route), 200, false),
    false,
  );
  assert.equal(
    skipD1({ ...fixture, COVE_PERF_TELEMETRY_MODE: "unrecognized" }, make(route), 200, false),
    false,
  );
}
assert.equal(skipD1(fixture, make("/api/fore/checkout"), 200, false), false);
assert.equal(skipD1(fixture, make("/api/fore/reader"), 200, false), false);
assert.equal(skipD1(fixture, make("/api/fore/search/suggest"), 200, false), false);
assert.equal(skipD1(fixture, make("/api/fore/catalog", { method: "POST" }), 200, false), false);

// There is still one structured, request-correlated Worker console event.
// The production default must continue to persist all three operational
// tables, and all security/error writes retain their existing path.
import fs from "node:fs";
const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
const ops = fs.readFileSync("src/features/fore/operations.server.ts", "utf8");
assert.match(api, /persist: !shouldUseConsoleOnlyHttpTelemetry\(/);
assert.match(ops, /if \(input.persist !== false\)/);
assert.match(ops, /telemetrySink: "worker-log"/);
assert.match(ops, /INSERT INTO ops_trace_spans/);
assert.match(ops, /INSERT INTO ops_metric_points/);
assert.match(ops, /export async function recordErrorEvent/);
assert.match(ops, /event: "http_request"/);
console.log("Synthetic telemetry write isolation and retained security logging: PASS");
