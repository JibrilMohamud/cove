/* eslint-disable prettier/prettier -- Keep the evidence gates and failure assertions adjacent until source normalization. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { withSoundsCloudflare429Retry } from "./cf-api-429-retry.mjs";
import {
  publishCoveSounds,
  withTransientD1PublicationRetry,
} from "../../.output/strangler/sounds-publication.mjs";

const token = process.env.CLOUDFLARE_API_TOKEN || "";
assert.ok(token.length >= 10, "Cloudflare deployment token missing");
const account = "d26430caa63ec55f6612e32f36aca5e9";
const databaseId = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const bucket = "cove-sounds-private-presentation";
const namespace = "544267f3cf604c1d8976f1b06d258e24";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-sounds-seed-"));
let completed = 0;
const api = async (resource, options = {}) => {
  const r = await withSoundsCloudflare429Retry(
    () => fetch("https://api.cloudflare.com/client/v4/" + resource, {
      ...options,
      headers: {
        Authorization: "Bearer " + token,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(45_000),
    }),
    { resource, method: options.method || "GET",
      onRetry: ({ retry, delayMs }) =>
        console.warn(JSON.stringify({ event: "sounds_publication_cloudflare_429", retry, delayMs })),
    },
  );
  if (!r.ok) throw Error("Cloudflare seed API request failed: " + r.status);
  return r;
};
function query(sql, params) {
  assert.match(sql.trim(), /^(SELECT|WITH)\b/i);
  assert.doesNotMatch(sql, /;\s*\S|\b(INSERT|UPDATE|DELETE|REPLACE|DROP|CREATE|ALTER|ATTACH|PRAGMA|VACUUM)\b/i);
  return api(`accounts/${account}/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  }).then(async (r) => {
    const result = await r.json();
    if (!(result.success && result.result?.[0]?.success)) {
      // Only propagate this exact transient D1 quota signal into the bounded
      // retry helper. Never treat unrelated source, auth or legal errors as
      // transient; never echo D1 SQL or private API responses into CI logs.
      const messages = [
        ...(result.errors || []),
        ...(result.result?.[0]?.errors || []),
      ].map((x) => String(x?.message || x || ""));
      if (messages.some((x) => /D1 DB is overloaded|Too many resources consumed within a 10 second window/i.test(x)))
        throw Error("D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window");
      throw Error("Read-only source query failed");
    }
    const primary = result.result[0];
    // This workflow's out-of-band seed uses only guarded SELECTs. It is not
    // the runtime provider-enforced D1 Read credential, so assert the actual
    // REST response is primary-only and performed zero writes.
    if (primary.meta?.served_by_primary !== true ||
        primary.meta?.changed_db !== false ||
        primary.meta?.rows_written !== 0)
      throw Error("Sounds seed primary-only zero-write D1 proof missing");
    return primary;
  });
}
// The deployed hourly Worker uses its private provider-enforced D1 Read
// service. The out-of-band staging seed invokes the SAME one-query
// request-local interface, but still uses this workflow's guarded REST SELECT
// calls. Neither mode may reintroduce a native SOURCE_DB binding.
const seedReadService = {
  async query(statements) {
    assert.ok(Array.isArray(statements) && statements.length === 1,
      "Sounds seed only permits one bounded primary read per RPC");
    const [{ sql, params }] = statements;
    assert.ok(typeof sql === "string" && sql.length < 100_000);
    assert.ok(Array.isArray(params) && params.length <= 100);
    return [await query(sql, params)];
  },
};
function wrangler(args) {
  const r = spawnSync(
    "npm",
    ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", ...args],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_ACCOUNT_ID: account,
        CLOUDFLARE_SEND_METRICS: "false",
      },
    },
  );
  assert.equal(r.status, 0, "Private R2 publication failed: " + String(r.stderr).slice(-600));
}
try {
  // A scheduled public refresh can overlap this isolated release. Retry only
  // the known 10-second primary-D1 overload; never bypass publication checks.
  const output = await withTransientD1PublicationRetry(() => publishCoveSounds({
    COVE_CANONICAL_READONLY_RPC: "1",
    COVE_CANONICAL_READONLY: seedReadService,
    COVE_SOUNDS_PUBLICATION_ENABLED: "1",
    COVE_SOUNDS_MARKETS: "US",
    SOUNDS_PRESENTATION: {
      async put(key, value) {
        assert.match(key, /^sounds\/v1\/US\/[a-z0-9-]+\.json$/);
        const file = path.join(scratch, "snapshot.json");
        fs.writeFileSync(file, value, { mode: 0o600 });
        wrangler(["r2", "object", "put", bucket + "/" + key, "--remote", "--file", file]);
        const confirmed = path.join(scratch, "confirmed.json");
        wrangler(["r2", "object", "get", bucket + "/" + key, "--remote", "--file", confirmed]);
        assert.equal(fs.readFileSync(confirmed, "utf8"), value, "Published R2 snapshot differs");
        fs.unlinkSync(confirmed);
      },
    },
    SOUNDS_PRESENTATION_KV: {
      async put(key, value, { expirationTtl }) {
        assert.ok(expirationTtl >= 60 && expirationTtl <= 3600);
        const resource = `accounts/${account}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}?expiration_ttl=${expirationTtl}`;
        const r = await api(resource, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: value,
        });
        const confirm = await r.json();
        assert.equal(confirm.success, true, "KV publication failed");
        completed++;
      },
    },
  }), undefined, (retry) =>
    console.warn(JSON.stringify({ event: "seed_cove_sounds_d1_throttled", retry })),
  );
  assert.equal(completed, 6, "All six private station snapshots must be published");
  assert.equal(output[0]?.stations, 6);
  assert.ok(output[0].recordings > 0, "No approved US music: refuse publication activation");
  console.log(JSON.stringify({ event: "cove-sounds-private-seeded", output, durableObjects: completed }));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
