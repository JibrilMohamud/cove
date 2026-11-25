import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./sounds-read-observer.worker.mjs";

test("observer rejects anonymous, expired, arbitrary and mismatched snapshots", async () => {
  const gate = "a".repeat(64);
  const snapshot = (key) =>
    JSON.stringify({
      schema: "cove.sounds.station.v1",
      territory: "US",
      slug: key.split("/").at(-1).replace(".json", ""),
      expiresAt: Date.now() + 600000,
      recordings: [],
      candidateProductIds: [],
    });
  const env = {
    GATE: gate,
    EXPIRES: String(Date.now() + 60000),
    SOUNDS_PRESENTATION: {
      async get(key) {
        const body = snapshot(key);
        return { size: body.length, text: async () => body };
      },
    },
    SOUNDS_PRESENTATION_KV: { get: async (key) => snapshot(key) },
  };
  const request = (authorization = "Bearer " + gate, method = "GET", path = "/verify") =>
    new Request("https://fixture.invalid" + path, { method, headers: { authorization } });
  const now = Date.now;
  const fixed = now();
  Date.now = () => fixed;
  try {
    assert.equal((await worker.fetch(request(""), env)).status, 401);
    assert.equal((await worker.fetch(request("Bearer " + "b".repeat(64)), env)).status, 401);
    assert.equal((await worker.fetch(request(), { ...env, EXPIRES: "0" })).status, 403);
    assert.equal((await worker.fetch(request(undefined, "PUT"), env)).status, 404);
    assert.equal((await worker.fetch(request(undefined, "GET", "/other"), env)).status, 404);
    const good = await worker.fetch(request(), env);
    assert.equal(good.status, 200);
    assert.equal((await good.json()).rows.length, 6);
    const mismatch = { ...env, SOUNDS_PRESENTATION_KV: { get: async () => "{}" } };
    assert.equal((await worker.fetch(request(), mismatch)).status, 503);
  } finally {
    Date.now = now;
  }
});
