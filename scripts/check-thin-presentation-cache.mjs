import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-thin-metadata-"));
try {
  await build({
    entryPoints: ["src/storefront-thin/presentation-cache.ts"],
    outfile: path.join(dir, "cache.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { loadThinPresentationContext: cache } = await import(path.join(dir, "cache.mjs"));
  const env = {
    COVE_SSR_STAGING: "1",
    COVE_THIN_STOREFRONT: "synthetic-only",
    COVE_THIN_METADATA_CACHE: "1",
    COVE_PERF_DATABASE_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    FORE_DEFAULT_TERRITORY: "US",
  };
  const request =
    (language, country = "US", extra = {}) =>
      new Request("https://synthetic.example/api/fore/storefront/bootstrap", {
        headers: { "x-cove-client-country": country, "accept-language": language, ...extra },
      });
  const value = (country = "US") => ({
    rightsCountry: country,
    locale: "en-US",
    availableMarkets: [{ countryCode: country }],
    messages: { hello: "world" },
  });
  let reads = 0;
  const read = (country = "US") => async () => {
    reads++;
    return value(country);
  };
  const clock = (t) => () => t;

  // Defaults remain OFF, including other databases and anything not staging.
  const off = { ...env, COVE_THIN_METADATA_CACHE: "0" };
  await cache(request("off"), off, read(), clock(100));
  await cache(request("off"), off, read(), clock(100));
  assert.equal(reads, 2);
  await cache(
    request("prod-id"),
    { ...env, COVE_PERF_DATABASE_ID: "production" },
    read(),
    clock(100),
  );
  await cache(
    request("prod-id"),
    { ...env, COVE_PERF_DATABASE_ID: "production" },
    read(),
    clock(100),
  );
  assert.equal(reads, 4);

  const anonymous = request("cache-only");
  const first = await cache(anonymous, env, read(), clock(1000));
  first.messages.hello = "mutated-by-caller";
  const second = await cache(anonymous, env, read(), clock(1001));
  assert.equal(reads, 5, "only COMPLETED presentation metadata is reusable");
  assert.equal(second.messages.hello, "world", "each response gets its own copy");
  await cache(anonymous, env, read(), clock(3001));
  assert.equal(reads, 6, "metadata expires after two seconds");

  // Separate country and language; a cached US context must never become CA.
  await cache(request("cache-only", "CA"), env, read("CA"), clock(1000));
  const ca = await cache(request("cache-only", "CA"), env, read("CA"), clock(1001));
  assert.equal(ca.rightsCountry, "CA");
  assert.equal(reads, 7);
  await cache(request("different-locale"), env, read(), clock(1001));
  assert.equal(reads, 8);

  // Cookie-bearing and other identity-bearing visits cannot reuse a snapshot.
  await cache(request("cache-only", "US", { cookie: "session=yes" }), env, read(), clock(1001));
  await cache(
    request("cache-only", "US", { authorization: "Bearer auth" }),
    env,
    read(),
    clock(1001),
  );
  assert.equal(reads, 10);

  // No retained pending promise and no singleflight across separate requests.
  const pending = [];
  const deferred = () => new Promise((resolve) => pending.push(resolve));
  const simultaneous = request("two-independent-inflight");
  const p1 = cache(simultaneous, env, deferred, clock(5000));
  const p2 = cache(simultaneous, env, deferred, clock(5000));
  assert.equal(pending.length, 2, "every cold miss owns its own D1 read");
  pending.forEach((resolve) => resolve(value()));
  await Promise.all([p1, p2]);
  await cache(simultaneous, env, read(), clock(5001));
  assert.equal(reads, 10, "successfully completed result is reusable");

  await assert.rejects(
    () =>
      cache(
        request("db-outage"),
        env,
        () => Promise.reject(new Error("D1 unavailable")),
        clock(7000),
      ),
    /D1 unavailable/,
  );
  await cache(request("db-outage"), env, read(), clock(7000));
  assert.equal(reads, 11, "failures are never cached");
  await assert.rejects(
    () => cache(request("wrong-territory", "US"), env, read("CA"), clock(7100)),
    /country mismatch/,
  );
  await cache(request("wrong-territory", "US"), env, read(), clock(7100));
  assert.equal(reads, 13, "mismatched metadata never enters cache");

  await cache(request("x".repeat(257)), env, read(), clock(8000));
  await cache(request("x".repeat(257)), env, read(), clock(8000));
  assert.equal(reads, 15, "oversized user-input keys bypass the cache");

  console.log(
    "PASS: staging-only completed-value presentation cache; TTL, isolation, credentials, no pending I/O sharing, fail-closed.",
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
