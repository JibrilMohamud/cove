import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { produceHomepagePresentation } from "../../.output/strangler/presentation.mjs";

/** A bounded, read-only QA seed, never a production publication pipeline.
 * Only public catalog/presentation data is written to the private stage R2.
 * No source database mutation, user identity or access grant is copied. */
export async function seedReadOnlyPresentation({ token, source, prefix, directory, kvNamespaceId }) {
  assert.ok(token);
  assert.equal(source, "4bd657ac-8789-403e-a28c-93aba8d0a989");
  assert.match(prefix, /^campaign\/\d+\/real\/$/);
  if (kvNamespaceId) assert.equal(kvNamespaceId, "8245d5f2116a445d9571405b41b7c8c3");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/d1/database/${source}/query`;
  async function query(sql, params) {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/i);
    assert.doesNotMatch(
      sql,
      /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|PRAGMA|VACUUM)\b/i,
    );
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await r.json();
    assert.ok(
      r.ok && body.success && body.result[0].success,
      "Read-only production presentation seed failed",
    );
    return body.result[0];
  }
  function statement(sql, params = []) {
    return {
      bind(...values) {
        return statement(sql, values);
      },
      async all() {
        return query(sql, params);
      },
      async first() {
        return (await query(sql, params)).results[0] || null;
      },
    };
  }
  const db = {
    prepare: statement,
    async batch(statements) {
      return Promise.all(statements.map((s) => s.all()));
    },
  };
  await produceHomepagePresentation(db, "US", {
    async get() {
      throw Error("Producer must not read a serving snapshot");
    },
    async put(key, body) {
      fs.mkdirSync(directory, { recursive: true });
      const file = directory + "/private-presentation.json";
      fs.writeFileSync(file, body);
      const result = spawnSync(
        "npm",
        [
          "exec",
          "--yes",
          "--package=wrangler@4.151.0",
          "--",
          "wrangler",
          "r2",
          "object",
          "put",
          "cove-strangler-private-presentation-stage/" + prefix + key,
          "--remote",
          "--file",
          file,
        ],
        {
          encoding: "utf8",
          timeout: 120000,
          env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_SEND_METRICS: "false" },
        },
      );
      assert.equal(result.status, 0, "Private, namespaced presentation seed upload failed");
      // Optional stage-only read accelerator. This document contains public
      // display candidates, never legal grants, orders or private media URLs.
      // R2 remains the durable independent source and is written first.
      if (kvNamespaceId) {
        const objectKey = encodeURIComponent(prefix + key);
        const kvResponse = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/storage/kv/namespaces/${kvNamespaceId}/values/${objectKey}?expiration_ttl=1800`,
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
        const acknowledgment = await kvResponse.json();
        assert.ok(kvResponse.ok && acknowledgment.success, "Private QA KV upload failed");
      }
    },
  });
}
