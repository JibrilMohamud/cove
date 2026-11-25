import assert from "node:assert/strict";
import fs from "node:fs";
import { withStagePresentationStore } from "./stage-presentation-storage.mjs";
import { requireIsolatedCatalogSnapshotTarget } from "../performance/real-catalog-snapshot-safety.mjs";
import { produceHomepagePresentation } from "../../.output/strangler/presentation.mjs";

/** A bounded, read-only QA seed, never a production publication pipeline.
 * Only public catalog/presentation data is written to the private stage R2.
 * No source database mutation, user identity or access grant is copied. */
export async function seedReadOnlyPresentation({
  readToken,
  source,
  sourceName,
  prefix,
  directory,
  kvNamespaceId,
}) {
  assert.ok(readToken && readToken.length >= 20);
  assert.equal(requireIsolatedCatalogSnapshotTarget(source, sourceName).id, source);
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
      headers: { authorization: "Bearer " + readToken, "content-type": "application/json" },
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
  await withStagePresentationStore("real", async (storage) => {
    await produceHomepagePresentation(db, "US", {
    async get() {
      throw Error("Producer must not read a serving snapshot");
    },
    async put(key, body) {
      fs.mkdirSync(directory, { recursive: true });
      const file = directory + "/private-presentation.json";
      fs.writeFileSync(file, body);
      assert.equal(key, "private/presentation/v2/home/US.json");
      await storage.put("US", body);
    },
    });
  });
}
