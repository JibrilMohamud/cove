import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync("src/lib/persistence-backend-failure.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { backendFailureSource } = await import(
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
    "server-timing": "cove_api;dur=2, private_header;desc=\"secret\"",
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

const gateway = fs.readFileSync("src/lib/persistence-backend.ts", "utf8");
assert.match(gateway, /path === "\/api\/fore\/storefront\/bootstrap"/);
assert.match(gateway, /backendFailureSource\(response\.headers\)/);
assert.match(gateway, /if \(productionFallbackDenied\(env\)\)/);
console.log("Read-only persistence 5xx attribution and fail-closed bootstrap: PASS");
