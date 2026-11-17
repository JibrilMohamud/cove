import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync("src/lib/persistence-backend-failure.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { backendFailureSource, backendFailurePhase, backendFailureStage, backendFailureCategory } =
  await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

function classify(headers) {
  return backendFailureSource(new Headers(headers));
}

assert.equal(classify({}), "edge-or-runtime");
assert.equal(classify({ "x-cove-persistence": "d1-r2" }), "edge-or-runtime");
assert.equal(
  classify({ "x-cove-persistence": "d1-r2", "x-cove-backend-cache": "MISS" }),
  "worker-early",
);
assert.equal(
  classify({
    "x-cove-persistence": "d1-r2",
    "x-cove-backend-cache": "MISS",
    "server-timing": "cove_context;dur=21.2, cove_api;dur=42.5",
  }),
  "worker-api",
);
assert.equal(
  classify({
    "x-cove-persistence": "d1-r2",
    "x-cove-backend-cache": "HIT",
    "server-timing": 'cove_api;dur=2, private_header;desc="secret"',
  }),
  "worker-api",
);
assert.equal(
  classify({ "x-cove-persistence": "d1-r2", "x-cove-backend-cache": "spoofed" }),
  "edge-or-runtime",
);
assert.equal(
  classify({
    "x-cove-persistence": "remote-d1-r2",
    "x-cove-backend-cache": "MISS",
  }),
  "edge-or-runtime",
);
const secret = "private-token-do-not-emit";
assert.ok(!classify({ "server-timing": secret }).includes(secret));

const apiHeaders = {
  "x-cove-persistence": "d1-r2",
  "x-cove-backend-cache": "MISS",
  "content-type": "application/json; charset=utf-8",
  "server-timing": "cove_auth;dur=9.5, cove_context;dur=300.1, cove_api;dur=308.8",
};
assert.equal(backendFailurePhase(new Headers(apiHeaders)), "post-context");
assert.equal(
  backendFailurePhase(
    new Headers({ ...apiHeaders, "server-timing": "cove_auth;dur=11, cove_api;dur=15" }),
  ),
  "pre-context",
);
assert.equal(
  backendFailurePhase(new Headers({ "server-timing": "cove_context;dur=4" })),
  "untraced",
);
// The upstream Worker emits only fixed, numeric, phase-specific failure flags.
// On concurrent promise rejection, both phases can report failed; do not
// guess which one was first. Reject foreign provenance and forged values.
const flagged = (timing, extra = {}) =>
  new Headers({ ...apiHeaders, ...extra, "server-timing": timing });
assert.equal(
  backendFailureStage(flagged("cove_fault_context;dur=1.0, cove_api;dur=34")),
  "context",
);
assert.equal(
  backendFailureStage(flagged("cove_fault_catalog;dur=1.0, cove_api;dur=34")),
  "catalog",
);
for (const stage of ["preference", "market", "locale", "currency", "details"]) {
  assert.equal(
    backendFailureStage(
      flagged(`cove_fault_context;dur=1, cove_fault_context_${stage};dur=1, cove_api;dur=34`),
    ),
    `context-${stage}`,
    "Reviewed context subphase must be authenticated and exact",
  );
}
assert.equal(
  backendFailureStage(flagged("cove_fault_context_market;dur=1, cove_api;dur=34")),
  "unknown",
  "Missing parent failure cannot assign a context subphase",
);
assert.equal(
  backendFailureStage(
    flagged("cove_fault_context;dur=1, cove_fault_context_market;dur=10, cove_api;dur=34"),
  ),
  "context",
  "Untrusted or malformed numeric detail cannot alter parent attribution",
);
assert.equal(
  backendFailureStage(
    flagged(
      "cove_fault_context;dur=1, cove_fault_context_market;dur=1, cove_fault_context_currency;dur=1, cove_api;dur=34",
    ),
  ),
  "multiple",
  "Competing context subphases must not be falsely pinpointed",
);
assert.equal(
  backendFailureStage(
    flagged(
      "cove_fault_context;dur=1, cove_fault_catalog;dur=1, cove_fault_context_market;dur=1, cove_api;dur=34",
    ),
  ),
  "multiple",
  "Competing catalog+context failures must remain ambiguous",
);
assert.equal(
  backendFailureStage(flagged("cove_fault_markets;dur=1.0, cove_api;dur=34")),
  "markets",
);
assert.equal(backendFailureStage(flagged("cove_fault_limit;dur=1.0, cove_api;dur=34")), "limit");
assert.equal(backendFailureStage(flagged("cove_fault_page;dur=1.0, cove_api;dur=34")), "page");
assert.equal(
  backendFailureStage(
    flagged("cove_fault_catalog;dur=1.0, cove_fault_context;dur=1.0, cove_api;dur=34"),
  ),
  "multiple",
);
assert.equal(
  backendFailureStage(flagged("cove_fault_catalog;dur=10.0, cove_api;dur=34")),
  "unknown",
);
assert.equal(
  backendFailureStage(flagged("cove_fault_strange;dur=1.0, cove_api;dur=34")),
  "unknown",
);
assert.equal(backendFailureStage(flagged("cove_api;dur=34")), "unknown");
assert.equal(
  backendFailureStage(
    flagged("cove_fault_catalog;dur=1.0, cove_api;dur=34", {
      "x-cove-persistence": "not-from-backend",
    }),
  ),
  "unknown",
);
// Exercise the actual privacy-only marker helper with sync and async failures.
const faultMarkerSource = fs.readFileSync("src/lib/backend-api-fault-stage.ts", "utf8");
const { code: faultMarkerCode } = await transform(faultMarkerSource, { loader: "ts", format: "esm" });
const { markBackendFaultStage } = await import(
  "data:text/javascript;base64," + Buffer.from(faultMarkerCode).toString("base64"),
);
for (const stage of ["auth_handle", "identity", "catalog", "taxonomy"]) {
  const timings = {};
  assert.equal(await markBackendFaultStage(stage, () => "success", timings), "success");
  assert.deepEqual(timings, {}, "Success must never claim a failed boundary");
  const sensitive = new Error("SECRET_SQL_IDENTITY_DO_NOT_LOG");
  await assert.rejects(
    markBackendFaultStage(stage, async () => { throw sensitive; }, timings),
    (error) => error === sensitive,
  );
  assert.deepEqual(timings, { ["fault_" + stage]: 1 });
  assert.doesNotMatch(JSON.stringify(timings), /SECRET_SQL_IDENTITY_DO_NOT_LOG/);
  const synchronous = {};
  await assert.rejects(
    markBackendFaultStage(stage, () => { throw sensitive; }, synchronous),
    (error) => error === sensitive,
  );
  assert.deepEqual(synchronous, { ["fault_" + stage]: 1 });
}
const apiSource = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
// The actual Worker annotates ONLY rejected, enumerated first-paint phases.
// Do not weaken the fail-closed exception path or emit raw exception details.
assert.match(
  apiSource,
  /type FirstPaintPhase = "context" \| "catalog" \| "markets" \| "limit" \| "page"/,
);
assert.match(apiSource, /timings\[`fault_\$\{name\}`\] = 1/);
assert.match(apiSource, /catch \(error\) \{\s*timings\[`fault_\$\{name\}`\] = 1;\s*throw error;/);
assert.equal((apiSource.match(/timings\[`fault_\$\{name\}`\] = 1/g) || []).length, 1);
assert.match(apiSource, /timings\[`fault_context_\$\{stage\}`\] = 1/);
// Authenticate stage labels with genuine provenance, reject competing or forged markers.
for (const stage of ["auth_handle", "identity", "catalog", "taxonomy"]) {
  const expected = stage === "auth_handle" ? "auth-handler" : stage;
  assert.equal(backendFailureStage(flagged("cove_fault_" + stage + ";dur=1, cove_api;dur=34")), expected);
  assert.equal(backendFailureStage(flagged("cove_fault_" + stage + ";dur=2, cove_api;dur=34")), "unknown");
  assert.equal(backendFailureStage(flagged("cove_fault_" + stage + ";dur=1", {
    "x-cove-persistence": "spoofed",
  })), "unknown");
}
assert.equal(
  backendFailureStage(flagged("cove_fault_identity;dur=1, cove_fault_catalog;dur=1, cove_api;dur=34")),
  "multiple",
  "Never misattribute competing errors to one stage",
);
assert.match(apiSource, /markBackendFaultStage\("auth_handle", \(\) => auth\.handle\(path\), timings\)/);
assert.match(apiSource, /markBackendFaultStage\("identity", \(\) => auth\.identify\(\), timings\)/);
assert.match(apiSource, /markBackendFaultStage\(\s*"catalog"/);
assert.match(apiSource, /markBackendFaultStage\(\s*"taxonomy"/);
const localizationSource = fs.readFileSync("src/features/fore/localization.server.ts", "utf8");
assert.match(localizationSource, /onFailureStage\?\.\(stage\)/);
assert.match(localizationSource, /stageRead\("market"/);
assert.match(localizationSource, /stageRead\("currency"/);
assert.match(localizationSource, /stageRead\("details"/);

// Isolated regression of the same propagation and numeric-only marker contract.
const signalSource = fs.readFileSync("src/lib/fore-phase-failure-signal.stage.ts", "utf8");
const { code: signalCode } = await transform(signalSource, { loader: "ts", format: "esm" });
const { markFailedTimedPhase } = await import(
  "data:text/javascript;base64," + Buffer.from(signalCode).toString("base64")
);
const metrics = {};
assert.equal(await markFailedTimedPhase("context", Promise.resolve("ready"), metrics), "ready");
assert.equal(metrics.fault_context, undefined, "Successful context must not register a fault");
const originalFault = new Error("sensitive-upstream-error-value");
await assert.rejects(
  markFailedTimedPhase("catalog", Promise.reject(originalFault), metrics),
  (error) => error === originalFault,
);
assert.equal(metrics.fault_catalog, 1, "A catalog rejection marks its fixed numeric phase");
assert.doesNotMatch(JSON.stringify(metrics), /sensitive-upstream-error-value/);
const errorResponse = (error, headers = apiHeaders) =>
  Response.json({ error }, { status: 503, headers });
for (const [error, category] of [
  [
    "The catalog is temporarily unavailable while Cove verifies distribution rights.",
    "catalog-rights",
  ],
  ["No active Cove storefront market is configured.", "market-configuration"],
  ["This storefront has no active locale configured.", "locale-configuration"],
  ["Native storefront read limiter is unavailable.", "rate-limit"],
  ["This content could not be loaded. Please try again.", "handler-exception"],
  ["untrusted private token, user details, SQL", "other"],
]) {
  assert.equal(await backendFailureCategory(errorResponse(error)), category);
}
assert.equal(
  await backendFailureCategory(errorResponse("any", { "content-type": "application/json" })),
  "other",
);
assert.equal(
  await backendFailureCategory(
    Response.json({ error: "private" }, { status: 200, headers: apiHeaders }),
  ),
  "other",
);
// A trusted 503 body is optional diagnostic evidence, not customer data.
// Even a malicious or wedged upstream stream must not delay fail-closed 503.
const encoded = (value) => new TextEncoder().encode(value);
const oneKB = "x".repeat(1025);
assert.equal(
  await backendFailureCategory(new Response(oneKB, { status: 503, headers: apiHeaders })),
  "other",
  "No Content-Length must not allow an unbounded upstream body",
);
assert.equal(
  await backendFailureCategory(
    new Response("{}", {
      status: 503,
      headers: { ...apiHeaders, "content-length": "infinity" },
    }),
  ),
  "other",
  "Malformed content length cannot grant unbounded parsing",
);
assert.equal(
  await backendFailureCategory(
    new Response('{"error":"No active Cove storefront market is configured."}', {
      status: 503,
      headers: { ...apiHeaders, "content-length": "4096" },
    }),
  ),
  "other",
  "Declared oversized body is rejected without parsing",
);
const delayed = new ReadableStream({
  start(controller) {
    controller.enqueue(encoded('{"error":"No active Cove '));
    setTimeout(() => {
      controller.enqueue(encoded('storefront market is configured."}'));
      controller.close();
    }, 20);
  },
});
assert.equal(
  await backendFailureCategory(new Response(delayed, { status: 503, headers: apiHeaders })),
  "market-configuration",
  "Bounded split JSON within the deadline retains existing diagnostics",
);
const oversize = new ReadableStream({
  start(controller) {
    controller.enqueue(encoded(oneKB));
    controller.close();
  },
});
assert.equal(
  await backendFailureCategory(new Response(oversize, { status: 503, headers: apiHeaders })),
  "other",
  "Actual byte count, not just Content-Length, must enforce 1KiB maximum",
);
const stalled = new ReadableStream({
  start() {
    // Upstream sends HTTP 503 headers but never finishes its JSON body.
  },
});
const started = performance.now();
assert.equal(
  await Promise.race([
    backendFailureCategory(new Response(stalled, { status: 503, headers: apiHeaders })),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Gateway 503 diagnostic read never terminated")), 800),
    ),
  ]),
  "other",
  "An indefinite upstream body may not prevent returning a fail-closed 503",
);
assert.ok(
  performance.now() - started < 550,
  "Error categorization must remain bounded independently of upstream body completion",
);

const gateway = fs.readFileSync("src/lib/persistence-backend.ts", "utf8");
assert.match(gateway, /path === "\/api\/fore\/storefront\/bootstrap"/);
assert.match(gateway, /backendFailureSource\(response\.headers\)/);
assert.match(gateway, /backendFailurePhase\(response\.headers\)/);
assert.match(gateway, /backendFailureStage\(response\.headers\)/);
assert.match(gateway, /await backendFailureCategory\(response\)/);
assert.doesNotMatch(gateway, /await response\.body\?\.cancel\(\)/);
assert.match(gateway, /void response\.body\?\.cancel\(\)\.catch\(\(\) => \{\}\)/);
assert.match(gateway, /if \(productionFallbackDenied\(env\)\)/);
console.log("Read-only persistence 5xx attribution and fail-closed bootstrap: PASS");
