import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync("src/features/fore/anonymous-catalog-rate-limit-policy.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { canEdgeLimitAnonymousCatalog: eligible } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const origin = "https://cove-persistence-backend.workers.dev";
const url = origin + "/api/fore/catalog?search=&sort=popular&page=1&currency=USD";
const edge = { limit: async () => ({ success: true }) };
const guest = new Request(url, {
  headers: { "cf-connecting-ip": "192.0.2.15" },
});
assert.equal(eligible(guest, null, "catalog", edge), true);
assert.equal(eligible(guest, "signed-in", "catalog", edge), false);
assert.equal(eligible(guest, null, "suggest", edge), false);
assert.equal(eligible(guest, null, "click", edge), false);
assert.equal(eligible(guest, null, "catalog", null), false);
assert.equal(eligible(guest, null, "catalog", {}), false);
assert.equal(eligible(guest, null, "catalog", { limit: true }), false);

for (const header of [
  "authorization",
  "cookie",
  "oai-authenticated-user-id",
  "oai-authenticated-user-email",
  "x-fore-authenticated-user-id",
]) {
  const request = new Request(guest);
  request.headers.set(header, "placeholder-not-a-real-secret");
  assert.equal(eligible(request, null, "catalog", edge), false, header);
}
for (const [path, method] of [
  ["/api/fore/catalog-extra", "GET"],
  ["/api/fore/search/suggest", "GET"],
  ["/api/fore/catalog", "POST"],
  ["/api/fore/catalog", "DELETE"],
]) {
  const request = new Request(origin + path, { method });
  assert.equal(eligible(request, null, "catalog", edge), false);
}

// Every successful guest admission actually consumes the bound rate limit.
// No code path substitutes an unchecked return or silently treats a failed
// edge invocation as an approved request.
const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
const index = api.indexOf("export async function rateLimitSearchRequest(");
const finish = api.indexOf("/** First-paint", index);
assert.ok(index > 0 && finish > index);
const admission = api.slice(index, finish);
assert.match(admission, /canEdgeLimitAnonymousCatalog\(request, userId, bucket, env\.COVE_STOREFRONT_READ_LIMITER\)/);
assert.match(admission, /await enforceFirstPaintRateLimit\(env, key, limit\);\s*return;/);
assert.match(admission, /await rateLimit\(env, key, limit\)/);
assert.match(api, /rateLimitSearchRequest\(request, env, searchUserId, "catalog", 180\)/);

const limiter = fs.readFileSync("src/features/fore/storefront-read-rate-limit.server.ts", "utf8");
assert.match(limiter, /if \(verdict\?\.success === false\)/);
assert.match(limiter, /if \(verdict\?\.success !== true\)/);
assert.match(limiter, /throw new ApiError\(503, "Native storefront read limiter is unavailable\."\)/);

const deployment = fs.readFileSync("wrangler.backend.production.toml", "utf8");
assert.match(deployment, /name = "COVE_STOREFRONT_READ_LIMITER"/);
console.log(
  "Guest catalog uses bounded edge admission only; authenticated, other routes, missing bindings and failures remain protected.",
);
