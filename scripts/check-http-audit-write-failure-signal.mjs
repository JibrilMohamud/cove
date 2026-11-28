import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";

// Exercise the REAL implementation with a fake D1: no production mutations.
const source = readFileSync("src/features/fore/operations.server.ts", "utf8");
const start = source.indexOf("export async function recordHttpRequest(");
const end = source.indexOf("\nexport async function recordErrorEvent(", start);
assert.ok(start >= 0 && end > start);
const isolatedSource = `
const now = () => "2026-11-14T22:00:00.000Z";
const id = () => "synthetic-audit-id";
const isPrimaryD1Overload = error => error?.code === 7429;
const dispatchQaOperationalWrite = () => null;
${source.slice(start, end)}
`;
const { code } = await transform(isolatedSource, { loader: "ts", format: "esm" });
const { recordHttpRequest } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const trace = {
  startedMs: Date.now() - 17,
  startedAt: "2026-11-14T22:00:00.000Z",
  requestId: "test-request-id",
  traceId: "test-trace-id",
  spanId: "test-span-id",
  parentSpanId: null,
};
const request = new Request("https://cove.invalid/api/fore/catalog?token=sensitive-value");
const response = new Response(null, { status: 503 });
const stdout = [];
const warnings = [];
const priorWarn = console.warn;
const priorLog = console.log;
let batchCalls = 0;
let prepared = [];
const makeDb = (failure) => ({
  prepare(sql) {
    prepared.push(sql);
    return {
      bind(...args) {
        return { sql, args };
      },
    };
  },
  async batch(statements) {
    batchCalls++;
    assert.equal(statements.length, 3, "Existing audit batch must remain unchanged");
    if (failure) throw failure;
  },
});
try {
  console.warn = (...args) => warnings.push(args.join(" "));
  console.log = (...args) => stdout.push(args.join(" "));
  const overloaded = Object.assign(new Error("SECRET_SQL_OR_ID_7429"), { code: 7429 });
  await recordHttpRequest(makeDb(overloaded), trace, request, response, {
    actorKind: "anonymous",
  });
  assert.equal(batchCalls, 1, "Do not retry a failing audit batch on D1");
  assert.equal(warnings.length, 1);
  assert.deepEqual(JSON.parse(warnings[0]), {
    event: "ops_http_audit_write_failed",
    statusClass: "5xx",
    primaryD1Overload: true,
  });
  assert.equal(warnings[0].includes("SECRET_SQL_OR_ID_7429"), false);
  assert.equal(warnings[0].includes("sensitive-value"), false);
  assert.equal(warnings[0].includes("test-request-id"), false);
  assert.equal(stdout.length, 1, "Existing request log remains emitted");
  for (const table of ["ops_http_requests", "ops_trace_spans", "ops_metric_points"])
    assert.ok(
      prepared.some((sql) => sql.includes(table)),
      table,
    );
  prepared = [];
  await recordHttpRequest(makeDb(new Error("not 7429")), trace, request, response);
  assert.deepEqual(JSON.parse(warnings[1]), {
    event: "ops_http_audit_write_failed",
    statusClass: "5xx",
    primaryD1Overload: false,
  });
  await recordHttpRequest(makeDb(null), trace, request, response);
  assert.equal(warnings.length, 2, "Successful HTTP auditing must emit no failure");
  assert.equal(batchCalls, 3);
} finally {
  console.warn = priorWarn;
  console.log = priorLog;
}
console.log(
  "PASS: failing D1 HTTP audits emit safe, low-cardinality signal, never retry or expose SQL/identity",
);
