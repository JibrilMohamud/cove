import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync("src/lib/persistence-backend-failure.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { backendFailureSource, backendFailurePhase, backendFailureCategory } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

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
const gateway = fs.readFileSync("src/lib/persistence-backend.ts", "utf8");
assert.match(gateway, /path === "\/api\/fore\/storefront\/bootstrap"/);
assert.match(gateway, /backendFailureSource\(response\.headers\)/);
assert.match(gateway, /backendFailurePhase\(response\.headers\)/);
assert.match(gateway, /await backendFailureCategory\(response\)/);
assert.match(gateway, /if \(productionFallbackDenied\(env\)\)/);
console.log("Read-only persistence 5xx attribution and fail-closed bootstrap: PASS");
