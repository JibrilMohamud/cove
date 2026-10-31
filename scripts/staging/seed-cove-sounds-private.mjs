/* eslint-disable prettier/prettier -- Keep the evidence gates and failure assertions adjacent until source normalization. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readSoundsPublicationSource } from "../../.output/strangler/sounds-source-reader.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { publishCoveSounds } from "../../.output/strangler/sounds-publication.mjs";

const token = process.env.CLOUDFLARE_API_TOKEN || "";
assert.ok(token.length >= 10, "Cloudflare deployment token missing");
const account = "d26430caa63ec55f6612e32f36aca5e9";
const databaseId = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const bucket = "cove-sounds-private-presentation";
const namespace = "544267f3cf604c1d8976f1b06d258e24";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-sounds-seed-"));
let completed = 0;
const seedReaderSecret = randomBytes(32).toString("hex");
const api = async (resource, options = {}) => {
  const r = await fetch("https://api.cloudflare.com/client/v4/" + resource, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(45_000),
  });
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
    assert.ok(result.success && result.result?.[0]?.success, "Read-only source query failed");
    return result.result[0];
  });
}
function statement(sql, params = []) {
  return {
    bind(...values) { return statement(sql, values); },
    all() { return query(sql, params); },
  };
}
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
  const output = await publishCoveSounds({
    COVE_SOUNDS_SOURCE_READER_SECRET: seedReaderSecret,
    SOUNDS_SOURCE_READER: { fetch: request => readSoundsPublicationSource(request, {
      PRIMARY_DB: { prepare: statement }, COVE_RIGHTS_OWNER_PRIMARY_ID: databaseId,
      COVE_SOUNDS_SOURCE_READER_SECRET: seedReaderSecret,
    }) },
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
  });
  assert.equal(completed, 6, "All six private station snapshots must be published");
  assert.equal(output[0]?.stations, 6);
  assert.ok(output[0].recordings > 0, "No approved US music: refuse publication activation");
  console.log(JSON.stringify({ event: "cove-sounds-private-seeded", output, durableObjects: completed }));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
