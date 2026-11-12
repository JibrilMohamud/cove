import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-catalog-admission-"));
try {
  const bundle = path.join(dir, "admission.mjs");
  await build({
    entryPoints: ["src/features/fore/service.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "silent",
  });
  const { rateLimit, ApiError } = await import(pathToFileURL(bundle).href);
  const edgeKey = "search:catalog:ip:192.0.2.33";
  let writes = 0;
  let edgeCalls = 0;
  let edgeResult = { success: true };
  let edgeFailure = false;
  let durableCount = 1;
  const env = {
    COVE_STOREFRONT_READ_LIMITER: {
      limit: async ({ key }) => {
        edgeCalls++;
        assert.equal(key, edgeKey);
        if (edgeFailure) throw new Error("private failure must never be returned");
        return edgeResult;
      },
    },
    DB: {
      prepare: (sql) => {
        writes++;
        assert.match(sql, /^INSERT INTO rate_limits/);
        return {
          bind: () => ({
            first: async () => ({ count: durableCount }),
          }),
        };
      },
    },
  };
  await rateLimit(env, edgeKey, 180);
  assert.equal(edgeCalls, 1);
  assert.equal(writes, 0, "Guest catalog cannot write a rate counter to primary D1");

  edgeResult = { success: false };
  await assert.rejects(rateLimit(env, edgeKey, 180), (error) => {
    assert.ok(error instanceof ApiError);
    return error.status === 429;
  });
  assert.equal(writes, 0, "Edge quota denial must not initiate D1 work");

  edgeResult = { success: undefined };
  await assert.rejects(rateLimit(env, edgeKey, 180), (error) => {
    assert.ok(error instanceof ApiError);
    return error.status === 503;
  });
  assert.equal(writes, 0, "Unknown edge quota verdict must fail closed");

  edgeFailure = true;
  await assert.rejects(rateLimit(env, edgeKey, 180), (error) => {
    assert.ok(error instanceof ApiError);
    return error.status === 503 && !error.message.includes("private failure");
  });
  edgeFailure = false;
  edgeResult = { success: true };
  assert.equal(writes, 0);

  // User-based, unrelated search and a missing edge binding all keep
  // durable admission and are never granted by an anonymous edge verdict.
  for (const key of [
    "search:catalog:user:reader",
    "search:suggest:ip:192.0.2.33",
    "search:click:ip:192.0.2.33",
    "search:catalog:ip:",
  ]) {
    const before = writes;
    await rateLimit(env, key, 180);
    assert.equal(writes, before + 1, key);
  }
  const noEdge = { ...env, COVE_STOREFRONT_READ_LIMITER: undefined };
  const before = writes;
  await rateLimit(noEdge, edgeKey, 180);
  assert.equal(writes, before + 1, "Missing edge binding must use D1, not bypass admission");
  durableCount = 181;
  await assert.rejects(rateLimit(noEdge, edgeKey, 180), (error) => {
    assert.ok(error instanceof ApiError);
    return error.status === 429;
  });

  durableCount = 1;
  const beforeNonstandard = writes;
  await rateLimit(env, edgeKey, 181);
  assert.equal(writes, beforeNonstandard + 1, "Unexpected quotas keep durable admission");

  const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
  const start = api.indexOf("export async function rateLimitSearchRequest(");
  const end = api.indexOf("/** First-paint", start);
  assert.ok(start > 0 && end > start);
  assert.match(api.slice(start, end), /if \(actor\) await rateLimit\(env, `search:\$\{bucket\}:\$\{actor\}`, limit\);/);
  assert.match(api, /rateLimitSearchRequest\(request, env, searchUserId, "catalog", 180\)/);
  assert.match(api, /const actor = userId \? `user:\$\{userId\}` : ip \? `ip:\$\{ip\}` : null;/);
  const deployment = fs.readFileSync("wrangler.backend.production.toml", "utf8");
  assert.match(deployment, /name = "COVE_STOREFRONT_READ_LIMITER"/);
  const service = fs.readFileSync("src/features/fore/service.ts", "utf8");
  assert.match(service, /async function tryGuestCatalogEdgeLimit/);
  assert.match(service, /if \\(await tryGuestCatalogEdgeLimit\\(env, key, limit\\)\\) return;/);
  assert.match(service, /limit !== 180/);
  assert.match(service, /INSERT INTO rate_limits\\(key,window_start,count\\)/);
  assert.match(service, /key\.startsWith\("search:catalog:ip:"\)/);
  console.log("Anonymous catalog edge admission and protected D1 fallback: PASS");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
