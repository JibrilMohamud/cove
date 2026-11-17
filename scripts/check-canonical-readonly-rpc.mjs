import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const miniflarePath = process.env.COVE_MINIFLARE_MODULE || "miniflare";
const { Miniflare, convertV4MiniflareOptions } = require(miniflarePath);
const config = readFileSync("wrangler.frontend.staging.toml", "utf8");
assert.doesNotMatch(config, /\[\[d1_databases\]\]/);
assert.match(config, /binding = "COVE_CANONICAL_READONLY"/);
assert.match(config, /service = "cove-canonical-d1-readonly"/);
assert.match(config, /COVE_CANONICAL_READONLY_RPC = "1"/);
const temp = mkdtempSync(path.join(tmpdir(), "cove-readonly-"));
let mf;
try {
  await build({
    entryPoints: ["infra/canonical-readonly/worker.ts"],
    bundle: true,
    external: ["cloudflare:workers"],
    format: "esm",
    outfile: path.join(temp, "owner.mjs"),
  });
  await build({
    entryPoints: ["src/lib/canonical-readonly-d1.server.ts"],
    bundle: true,
    format: "esm",
    outfile: path.join(temp, "facade.mjs"),
  });
  const facade = readFileSync(path.join(temp, "facade.mjs"), "utf8").replace(
    /export \{[\s\S]*?\};/,
    "",
  );
  let calls = 0;
  let mode = "ok";
  const options = {
    workers: [
      {
        name: "readonly",
        rootPath: temp,
        modules: [
          {
            type: "ESModule",
            path: "owner.mjs",
            contents: readFileSync(path.join(temp, "owner.mjs"), "utf8"),
          },
        ],
        compatibilityDate: "2026-10-17",
        bindings: { D1_READ_API_TOKEN: "not-a-production-token" },
        outboundService: async (request) => {
          calls++;
          assert.equal(
            request.url,
            "https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/d1/database/4bd657ac-8789-403e-a28c-93aba8d0a989/query",
          );
          assert.equal(request.headers.get("authorization"), "Bearer not-a-production-token");
          const { batch } = await request.json();
          if (mode === "write-denied")
            return Response.json({ errors: [{ message: "private SQL" }] }, { status: 400 });
          return Response.json({
            success: true,
            result: batch.map((q) => ({
              success: true,
              results: [{ value: q.params[0] ?? 42 }],
              meta: { served_by_primary: mode !== "replica" },
            })),
          });
        },
      },
      {
        name: "readonly-stage",
        rootPath: temp,
        modules: [
          {
            type: "ESModule",
            path: "owner.mjs",
            contents: readFileSync(path.join(temp, "owner.mjs"), "utf8"),
          },
        ],
        compatibilityDate: "2026-10-17",
        bindings: {
          D1_READ_API_TOKEN: "not-a-production-token",
          COVE_STAGE_READ_PHASE_DIAGNOSTICS: "1",
        },
        outboundService: async (request) => {
          calls++;
          const { batch } = await request.json();
          return Response.json({
            success: true,
            result: batch.map((q) => ({
              success: true,
              results: [{ value: q.params[0] ?? 42 }],
              meta: { served_by_primary: mode !== "replica" },
            })),
          });
        },
      },
      {
        name: "client",
        rootPath: temp,
        modules: true,
        compatibilityDate: "2026-10-17",
        serviceBindings: { READ: "readonly", READ_STAGE: "readonly-stage" },
        script:
          facade +
          `
      export default { async fetch(request, env) {
        const db = canonicalReadonlyD1(env.READ);
        if (new URL(request.url).pathname === "/stage-burst") {
          const replies = await Promise.all(Array.from({ length: 24 }, (_, i) =>
            env.READ_STAGE.fetch("https://stage.internal/__cove/stage/primary-read", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ batch: [{ sql: "SELECT ? AS value", params: [i] }] }),
            })
          ));
          const bodies = await Promise.all(replies.map((reply) => reply.json().catch(() => null)));
          return Response.json({
            statuses: replies.map((reply) => reply.status),
            values: bodies.map((body) => body?.result?.[0]?.results?.[0]?.value ?? null),
          });
        }
        try {
          const a = await db.prepare("SELECT ? AS value").bind(7).first("value");
          const b = await db.batch([db.prepare("SELECT ?").bind(9), db.prepare("SELECT 42")]);
          const c = await db.withSession("first-primary").prepare("SELECT 42").first();
          let runDenied = false;
          try { await db.prepare("DELETE FROM books").run(); } catch { runDenied = true; }
          const stageResponse = await env.READ_STAGE.fetch(
          "https://stage.internal/__cove/stage/primary-read",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ batch: [{ sql: "SELECT ?", params: [77] }] }),
          },
        );
        if (stageResponse.status !== 200) throw new Error("Staging private fetch failed");
        const stagePayload = await stageResponse.json();
        const stageValue = stagePayload.result[0].results[0].value;
        return Response.json({ a, b, c, runDenied, stageValue });
        } catch (e) { return Response.json({ error: e.message }, { status: 503 }); }
      } };`,
      },
    ],
  };
  mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  const client = await mf.getWorker("client");
  console.log("STAGE_WORKER_INTEGRATION_START");
  const result = await (await client.fetch("https://test/")).json();
  console.log("STAGE_WORKER_SINGLE_READ_COMPLETED");
  assert.equal(result.a, 7);
  assert.deepEqual(
    result.b.map((x) => x.results[0].value),
    [9, 42],
  );
  assert.equal(result.c.value, 42);
  assert.equal(result.runDenied, true);
  assert.equal(result.stageValue, 77, "Stage service fetch must read authoritative D1");
  assert.equal(calls, 4, "Three RPC requests plus one private placed fetch");
  // Multiple independent callers must receive their own primary result.
  // Also exercise Worker request-context isolation, not only the pure helper.
  const beforeBurst = calls;
  console.log("STAGE_WORKER_BURST_BEGIN");
  const stageBurst = await (await client.fetch("https://test/stage-burst")).json();
  console.log("STAGE_WORKER_BURST_COMPLETED");
  assert.deepEqual(stageBurst.statuses, Array(24).fill(200));
  assert.deepEqual(
    stageBurst.values,
    Array.from({ length: 24 }, (_, i) => i),
  );
  assert.ok(calls > beforeBurst && calls <= beforeBurst + 24);
  mode = "replica";
  assert.equal(
    (await client.fetch("https://test/")).status,
    503,
    "Replica results cannot certify live rights",
  );
  mode = "write-denied";
  const denied = await client.fetch("https://test/");
  assert.equal(denied.status, 503);
  assert.equal((await denied.text()).includes("private SQL"), false);
  const owner = await mf.getWorker("readonly");
  assert.equal((await owner.fetch("https://test/")).status, 404);
  const stage = await mf.getWorker("readonly-stage");
  assert.equal((await stage.fetch("https://test/")).status, 404);
  assert.equal(
    (await stage.fetch("https://test/__cove/stage/primary-read")).status,
    404,
    "Staging read endpoint never serves public GET",
  );
  await assert.rejects(async () => await owner.query([]));
  const before = calls;
  await assert.rejects(
    async () => await owner.query([{ sql: "SELECT 1", params: ["x".repeat(600_000)] }]),
  );
  assert.equal(calls, before, "Oversize input never reaches the provider");
  console.log(
    "PASS: actual Worker RPC, D1 facade batching, primary-only fail-closed reads, credential/error isolation",
  );
} finally {
  await mf?.dispose();
  rmSync(temp, { recursive: true, force: true });
}
