import assert from "node:assert/strict";
import fs from "node:fs";

const code = fs.readFileSync("src/features/fore/anonymous-http-metric.server.ts", "utf8");
const deploy = fs.readFileSync(".github/workflows/deploy-persistence-backend.yml", "utf8");
const handler = fs.readFileSync("src/features/fore/api.server.ts", "utf8");

assert.match(code, /env\.FORE_ENVIRONMENT === "production"/);
assert.match(code, /env\.COVE_PUBLIC_ANON_HTTP_TELEMETRY === "1"/);
assert.match(code, /env\.COVE_OPS_TELEMETRY_MODE !== "analytics-engine"/);
assert.match(code, /request\.headers\.has\("authorization"\)/);
assert.match(code, /request\.headers\.has\("cookie"\)/);
assert.match(code, /response\.status >= 300/);
assert.match(code, /actorKind !== "anonymous"/);
assert.match(code, /env\.OPS_ANALYTICS\.writeDataPoint/);
assert.match(handler, /if \(isSoundsAnalyticsAck\(tracedRequest, response\)\)/);
assert.match(handler, /const isolated = emitIsolatedAnonymousHttpMetric\(/);
assert.match(handler, /else if \(isolated\)/);
assert.match(handler, /recordHttpRequest\(env\.DB/);
assert.match(deploy, /ANON_METRICS="0"/);
assert.match(deploy, /WORKER_NAME" = "cove-persistence-backend"/);
assert.match(deploy, /D1_DATABASE_ID" = "4bd657ac-8789-403e-a28c-93aba8d0a989"/);
assert.match(deploy, /ANON_METRICS="1"/);
assert.match(deploy, /binding = "OPS_ANALYTICS"\s+dataset = "cove_public_http_ops"/);
assert.match(deploy, /COVE_PUBLIC_ANON_HTTP_TELEMETRY = "\$ANON_METRICS"/);
assert.match(deploy, /COVE_OPS_TELEMETRY_MODE = "analytics-engine"/);
const sinkStart = code.indexOf('blobs: ["public-api-read", path, "GET"]');
const sinkEnd = code.indexOf("});", sinkStart);
assert.ok(sinkStart >= 0 && sinkEnd > sinkStart);
const payload = code.slice(sinkStart, sinkEnd);
assert.match(payload, /blobs: \["public-api-read", path, "GET"\]/);
assert.match(payload, /doubles: \[response\.status,/);
assert.doesNotMatch(payload, /\b(query|productId|email|ipAddress|userId|cookie|request)\b/);
const failureStart = code.indexOf('blobs: ["public-api-failure", path, "5xx"]');
const failureEnd = code.indexOf("});", failureStart);
assert.ok(failureStart >= 0 && failureEnd > failureStart);
const failurePayload = code.slice(failureStart, failureEnd);
assert.match(failurePayload, /indexes: \["public-failure"\]/);
assert.doesNotMatch(
  failurePayload,
  /\b(query|productId|email|ipAddress|userId|cookie|request|message|exception)\b/,
);
assert.match(code, /response\.status >= 500 && response\.status <= 599/);
assert.match(code, /response\.status < 200 \|\| response\.status >= 300/);
// A 5xx AE counter must return false so handleCoveApi still executes the
// original durable D1 error/security audit logic.
assert.match(code, /indexes: \["public-failure"\][\s\S]*?return false;/);
assert.match(code, /const ANONYMOUS_PHASES = \["auth", "context", "identity"\]/);
assert.match(code, /const SLOW_MS = 800/);
assert.match(code, /indexes: \["public-anomaly"\]/);
assert.match(handler, /Date\.now\(\) - trace\.startedMs,\s*timings,/);
const phaseStart = code.indexOf('blobs: ["public-api-anomaly-phase", path, top]');
const phaseEnd = code.indexOf("});", phaseStart);
assert.ok(phaseStart >= 0 && phaseEnd > phaseStart);
const phasePayload = code.slice(phaseStart, phaseEnd);
assert.match(phasePayload, /doubles: \[status, elapsed, largest\]/);
assert.doesNotMatch(
  phasePayload,
  /\b(query|productId|email|ipAddress|userId|cookie|request|message|exception|errorText)\b/,
);
// A failure's additional numeric phase report cannot turn a 5xx into a
// successful unaudited call; the response still flows through durable D1.
assert.match(code, /recordAnonymousAnomalyPhase\([\s\S]*?\);\s*return false;/);
console.log(
  "PASS: only canonical production anonymous GET success metrics may bypass D1, with independently bound AE and retained error/security logging",
);
