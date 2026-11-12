import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync("src/lib/staging-empty-catalog-response.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const {
  stagingHomeNeedsUnavailableStatus: classify,
  sanitizedStagingCatalogFailureTiming: safeTiming,
} = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

const homepage = new Request("https://ssr-canary.covereads.com/");
const empty = () =>
  new Response("<!doctype html><title>Unavailable</title>", {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "server-timing": "cove_ssr_bootstrap;dur=312, cove_ssr_empty;dur=0",
    },
  });

assert.equal(classify(homepage, empty(), true), true);
assert.equal(classify(homepage, empty(), false), false);
assert.equal(
  classify(new Request("https://ssr-canary.covereads.com/?q=fiction"), empty(), true),
  false,
);
assert.equal(
  classify(new Request("https://ssr-canary.covereads.com/search"), empty(), true),
  false,
);
assert.equal(classify(new Request(homepage, { method: "HEAD" }), empty(), true), false);
assert.equal(classify(new Request(homepage, { method: "POST" }), empty(), true), false);
assert.equal(classify(homepage, new Response(null, { status: 503 }), true), false);
assert.equal(
  classify(
    homepage,
    Response.json({ catalog: null }, { headers: { "server-timing": "cove_ssr_empty;dur=0" } }),
    true,
  ),
  false,
);
assert.equal(
  classify(
    homepage,
    new Response("ok", {
      headers: {
        "content-type": "text/html",
        "server-timing": "cove_ssr_primary_failure;dur=99, cove_ssr_empty;dur=12",
      },
    }),
    true,
  ),
  false,
);

assert.equal(safeTiming(null), "cove_ssr_empty;dur=0");
assert.equal(
  safeTiming(
    "cove_ssr_bootstrap;dur=713.4, cove_ssr_primary_failure;dur=615.2, cove_ssr_primary_d1_overload;dur=0, cove_ssr_deadline;dur=0, cove_ssr_empty;dur=0",
  ),
  "cove_ssr_empty;dur=0, cove_ssr_bootstrap;dur=713.4, cove_ssr_primary_failure;dur=615.2, cove_ssr_primary_d1_overload;dur=0, cove_ssr_deadline;dur=0",
);
assert.equal(
  safeTiming(
    "cove_ssr_primary_transport_or_invalid;dur=0, cove_ssr_primary_throttled;dur=0, cove_ssr_primary_upstream_error;dur=0",
  ),
  "cove_ssr_empty;dur=0, cove_ssr_primary_transport_or_invalid;dur=0, cove_ssr_primary_throttled;dur=0, cove_ssr_primary_upstream_error;dur=0",
);
const injection = safeTiming(
  'cookie;desc="private", cove_ssr_primary_d1_overload;dur=0;desc="SECRET", user_ip;dur=77, cove_ssr_bootstrap;dur=13000, cove_ssr_deadline;dur=2, cove_ssr_primary_failure;dur=42.1',
);
assert.equal(injection, "cove_ssr_empty;dur=0, cove_ssr_primary_failure;dur=42.1");
assert.ok(!injection.includes("SECRET"));
assert.equal(
  safeTiming(
    "cove_ssr_empty;dur=0, cove_ssr_primary_d1_overload;dur=0, cove_ssr_primary_d1_overload;dur=0",
  ),
  "cove_ssr_empty;dur=0, cove_ssr_primary_d1_overload;dur=0",
);

const server = fs.readFileSync("src/server.ts", "utf8");
assert.match(server, /stagingHomeNeedsUnavailableStatus\(request, normalized, staging\)/);
assert.match(server, /const guarded = stagingHomeNeedsUnavailableStatus/);
assert.match(server, /status: 503,/);
assert.match(server, /"cache-control": "no-store"/);
assert.match(server, /"server-timing": sanitizedStagingCatalogFailureTiming\(/);
console.log(
  "Protected SSR staging empty-catalog responses are explicit 503; no live book rights fallback.",
);
