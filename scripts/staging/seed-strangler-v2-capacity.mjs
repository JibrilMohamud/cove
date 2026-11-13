import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { produceHomepagePresentation } from "../../.output/strangler/presentation.mjs";

// OUT-OF-BAND, STAGING-ONLY. No production D1 binding, customer traffic,
// legal owner, rights cache, payment state or public object can be modified.
const account = "d26430caa63ec55f6612e32f36aca5e9";
const databaseId = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const bucket = "cove-strangler-private-presentation-stage";
const kvId = "8245d5f2116a445d9571405b41b7c8c3";
const run = process.env.GITHUB_RUN_ID || "";
const token = process.env.CLOUDFLARE_API_TOKEN || "";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.match(run, /^[1-9][0-9]{7,14}$/);
assert.ok(token.length > 20, "A protected workflow credential is required");
const prefix = `campaign/${run}/synthetic/`;
assert.match(prefix, /^campaign\/[1-9][0-9]{7,14}\/synthetic\/$/);
const producer = JSON.parse(
  fs.readFileSync("wrangler.storefront-candidate-producer.stage.jsonc", "utf8"),
);
const consumer = JSON.parse(fs.readFileSync("wrangler.storefront-strangler.stage.jsonc", "utf8"));
assert.equal(producer.d1_databases?.[0]?.database_id, databaseId);
assert.equal(consumer.d1_databases?.[0]?.database_id, databaseId);
assert.equal(producer.r2_buckets?.[0]?.bucket_name, bucket);
assert.equal(producer.workers_dev, false);
assert.equal(producer.preview_urls, false);
assert.ok(!producer.routes && !producer.triggers);
const directory = ".output/strangler/private-v2-capacity";
fs.mkdirSync(directory, { recursive: true });

async function readOnly(sql, params = []) {
  assert.match(sql.trim(), /^(?:SELECT|WITH)\b/i);
  assert.doesNotMatch(sql, /;\s*\S|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM)\b/i);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) throw Error("Isolated stage D1 unavailable: " + response.status);
  const data = await response.json();
  const result = data.result?.[0];
  assert.equal(data.success, true, "Isolated D1 query refused");
  assert.equal(result?.success, true, "Isolated D1 statement failed");
  assert.ok(Array.isArray(result?.results));
  return result;
}
const statement = (sql, params = []) => ({
  bind(...values) {
    return statement(sql, values);
  },
  all() {
    return readOnly(sql, params);
  },
  async first() {
    return (await readOnly(sql, params)).results[0] ?? null;
  },
});
const db = {
  prepare: (sql) => statement(sql),
  batch: (statements) => Promise.all(statements.map((item) => item.all())),
};
const markets = (
  await readOnly(
    "SELECT country_code FROM storefront_markets WHERE market_status='active' ORDER BY country_code LIMIT 33",
  )
).results;
assert.ok(markets.length > 0 && markets.length <= 32);
const countries = markets.map((item) => String(item.country_code));
assert.ok(countries.includes("US"));
assert.ok(countries.every((country) => /^[A-Z]{2}$/.test(country)));

function wrangler(args) {
  const result = spawnSync(
    "npm",
    ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", ...args],
    {
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  if (result.status !== 0) throw Error("Private R2 staging operation failed");
}
async function writeCountry(country) {
  const written = [];
  const store = {
    async put(key, body) {
      assert.equal(key, `private/presentation/v2/home/${country}.json`);
      assert.ok(Buffer.byteLength(body, "utf8") < 512 * 1024);
      const document = JSON.parse(body);
      assert.equal(document.schema, "cove.home.presentation.v2");
      assert.equal(document.candidates.country, country);
      assert.ok(
        document.displayBooks.every((book) =>
          !("offer" in book) && !("subscriptionEligible" in book) && !("libraryEligible" in book),
        ),
        "A presentation must never contain cached offers or grants",
      );
      const file = path.join(directory, country + ".json");
      fs.writeFileSync(file, body, { mode: 0o600 });
      const objectKey = prefix + key;
      manifest.push({ country, objectKey });
      wrangler([
        "r2", "object", "put", bucket + "/" + objectKey,
        "--remote", "--file", file, "--content-type", "application/json",
      ]);
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(objectKey)}?expiration_ttl=1800`,
        {
          method: "PUT",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/octet-stream",
          },
          body,
          signal: AbortSignal.timeout(30000),
        },
      );
      const ack = await response.json();
      assert.ok(response.ok && ack.success, "Isolated presentation KV seed rejected");
      // Read back R2 bytes; KV is an advisory accelerator and never authority.
      const verified = path.join(directory, country + "-verified.json");
      wrangler(["r2", "object", "get", bucket + "/" + objectKey, "--remote", "--file", verified]);
      const digest = (fileName) =>
        createHash("sha256").update(fs.readFileSync(fileName)).digest("hex");
      assert.equal(digest(file), digest(verified), "Private stage R2 bytes mismatch");
      written.push({ country, objectKey });
    },
  };
  const generated = await produceHomepagePresentation(db, country, store);
  assert.equal(written.length, 1, "One complete atomic presentation per market");
  assert.equal(generated.country, country);
  assert.ok(generated.expiresAt > Date.now());
  // No book, private product identifier or grant is ever printed.
  console.log("COVE_STAGE_V2_SEEDED " + JSON.stringify({
    country, candidates: generated.candidates, locales: generated.locales,
    authority: "fresh-primary-per-request",
  }));
  return written[0];
}
const manifest = [];
try {
  for (const country of countries) await writeCountry(country);
} finally {
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({ schema: "cove.stage.v2.cleanup.v1", prefix, objects: manifest }),
    { mode: 0o600 },
  );
}
console.log("COVE_STAGE_V2_READY: run-scoped private R2/KV projections; no legal grants cached");
