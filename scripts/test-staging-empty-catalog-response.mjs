import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync("src/lib/staging-empty-catalog-response.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { stagingHomeNeedsUnavailableStatus: classify } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

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
assert.equal(
  classify(new Request(homepage, { method: "HEAD" }), empty(), true),
  false,
);
assert.equal(
  classify(new Request(homepage, { method: "POST" }), empty(), true),
  false,
);
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

const server = fs.readFileSync("src/server.ts", "utf8");
assert.match(server, /stagingHomeNeedsUnavailableStatus\(request, normalized, staging\)/);
assert.match(server, /const guarded = stagingHomeNeedsUnavailableStatus/);
assert.match(server, /status: 503,/);
assert.match(server, /"cache-control": "no-store"/);
assert.match(server, /"server-timing": "cove_ssr_empty;dur=0"/);
console.log("Protected SSR staging empty-catalog responses are explicit 503; no live book rights fallback.");
