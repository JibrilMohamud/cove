import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-read-limit-"));
try {
  await build({
    entryPoints: ["src/features/fore/storefront-read-rate-limit.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(dir, "limit.mjs"),
    logLevel: "silent",
  });
  const { enforceFirstPaintRateLimit } = await import(path.join(dir, "limit.mjs"));
  const recorded = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /INSERT INTO rate_limits/);
      return {
        bind(...values) {
          recorded.push(values[0]);
          return { first: async () => ({ count: 1 }) };
        },
      };
    },
  };
  const key = "search:catalog:ip:198.51.100.10";
  assert.equal(await enforceFirstPaintRateLimit({ DB: db }, key, 180), "d1");
  assert.deepEqual(recorded, [key]);
  const called = [];
  const edge = {
    DB: db,
    COVE_SSR_STAGING: "1",
    COVE_STOREFRONT_READ_LIMITER: {
      async limit({ key: value }) {
        called.push(value);
        return { success: true };
      },
    },
  };
  assert.equal(await enforceFirstPaintRateLimit(edge, key, 180), "edge");
  assert.deepEqual(called, [key]);
  assert.deepEqual(recorded, [key], "Allowed native SSR must not write to D1");
  await assert.rejects(
    enforceFirstPaintRateLimit(
      {
        ...edge,
        COVE_STOREFRONT_READ_LIMITER: { limit: async () => ({ success: false }) },
      },
      key,
      180,
    ),
    (error) => error.status === 429,
  );
  await assert.rejects(
    enforceFirstPaintRateLimit({ DB: db, COVE_SSR_STAGING: "1" }, key, 180),
    (error) => error.status === 503,
  );
  await assert.rejects(
    enforceFirstPaintRateLimit(
      {
        ...edge,
        COVE_STOREFRONT_READ_LIMITER: {
          limit: async () => {
            throw Error("offline");
          },
        },
      },
      key,
      180,
    ),
    (error) => error.status === 503,
  );
  assert.deepEqual(recorded, [key], "Stage deny/error must never silently bypass limiter");

  // Production must retain the same bounded anonymous admission path as the
  // already-tested staging Worker. It must not silently regress to a D1 write
  // before every first-paint legal-rights read on the persistence backend.
  const config = fs.readFileSync("wrangler.backend.production.toml", "utf8");
  const workflow = fs.readFileSync(".github/workflows/deploy-persistence-backend.yml", "utf8");
  for (const source of [config, workflow]) {
    assert.match(source, /name = "COVE_STOREFRONT_READ_LIMITER"/);
    assert.match(source, /namespace_id = "991731904"/);
    assert.match(source, /\[ratelimits\.simple\][\s\S]*?limit = 180\s+period = 60/);
  }
  assert.match(
    workflow,
    /required = \["FORE_INGESTION_SIGNING_KEY", "FORE_BACKEND_TOKEN_SHA256"\]/,
    "Production gateway authorization must have its protected verifier bound.",
  );
  console.log("Native SSR limiter, prod binding, denial and D1 fallback: PASS");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
