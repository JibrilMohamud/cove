import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// Real workerd request lifetimes, synthetic I/O only. The owner returns before
// its pending read completes. A separate visitor must retain its OWN read.
// Node-only Promise tests cannot reproduce workerd's cancellation semantics.
const sql =
  "WITH RECURSIVE active_market AS MATERIALIZED (SELECT 1), " +
  "chosen_locale AS MATERIALIZED (SELECT 1) " +
  "SELECT * FROM active_market m LEFT JOIN chosen_locale l ON 1=1";
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { withInFlightAnonymousMarketReads as wrap } from "./src/features/fore/storefront-inflight-public-metadata";
      let binding;
      export default { async fetch(request, env) {
        binding ??= { prepare: () => ({ bind: () => ({
          all: async () => (await env.SLOW.fetch("https://synthetic.invalid")).json()
        }) }) };
        // Exactly as in serveLeanAnonymousBootstrap: a fresh wrapper per request,
        // even though Cloudflare reuses the native binding across invocations.
        const db = wrap(binding);
        const task = db.prepare(${JSON.stringify(sql)}).bind("US", '["en-US"]').all();
        const owner = request.url.endsWith("/owner");
        return Promise.race([
          task.then(value => Response.json(value)),
          new Promise(resolve => setTimeout(() => resolve(
            new Response(owner ? "owner-exited" : "visitor-timeout", { status: 504 })
          ), owner ? 100 : 1500))
        ]);
      }};
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
let begin;
const began = new Promise((resolve) => (begin = resolve));
let reads = 0;
const runtime = new Miniflare({
  modules: true,
  script: outputFiles[0].text,
  // The pinned local binary's latest date. The relevant cross-request
  // continuation rule has been the default since 2024-10-14, as in staging.
  compatibilityDate: "2026-08-06",
  serviceBindings: {
    SLOW: async () => {
      reads++;
      begin();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return Response.json({ results: [{ presentation: "synthetic" }] });
    },
  },
});
try {
  const owner = runtime.dispatchFetch("https://synthetic.invalid/owner");
  await began;
  const visitor = runtime.dispatchFetch("https://synthetic.invalid/visitor");
  const first = await owner;
  assert.equal(first.status, 504);
  assert.equal(await first.text(), "owner-exited");
  const second = await visitor;
  assert.equal(second.status, 200, "Ending another request must not cancel this visitor's read");
  assert.deepEqual(await second.json(), { results: [{ presentation: "synthetic" }] });
  assert.equal(reads, 2, "Independent Worker requests must independently own their I/O");
  console.log(
    "Worker metadata request-lifetime isolation: PASS (owner timeout cannot strand visitor)",
  );
} finally {
  await runtime.dispose();
}
