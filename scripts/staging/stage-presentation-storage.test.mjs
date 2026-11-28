import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./stage-presentation-storage.worker.mjs";

test("stage storage denies forged, expired, cross-prefix and rights-bearing writes", async () => {
  const gate = "a".repeat(64);
  const objects = new Map();
  const kv = new Map();
  const env = {
    GATE: gate,
    EXPIRES: String(Date.now() + 60_000),
    RUN: "45552506145",
    MODE: "synthetic",
    INSTANCE: "c".repeat(32),
    PURPOSE: "publish",
    PRESENTATION: {
      async put(key, value) {
        objects.set(key, value);
      },
      async get(key) {
        return objects.has(key) ? { body: objects.get(key) } : null;
      },
      async delete(key) {
        objects.delete(key);
      },
    },
    PRESENTATION_KV: {
      async put(key, value, options) {
        assert.equal(options.expirationTtl, 1800);
        kv.set(key, value);
      },
      async delete(key) {
        kv.delete(key);
      },
    },
  };
  const valid = JSON.stringify({
    schema: "cove.home.presentation.v2",
    candidates: { country: "US" },
    displayBooks: [{ title: "fixture" }],
  });
  function request(method, body, overrides = {}, pathname = "/presentation") {
    return new Request("https://fixture.workers.dev" + pathname, {
      method,
      headers: {
        authorization: "Bearer " + gate,
        "x-cove-country": "US",
        ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
        ...overrides,
      },
      ...(body === undefined ? {} : { body }),
    });
  }
  for (const authorization of ["", "Bearer " + "b".repeat(64)]) {
    assert.equal((await worker.fetch(request("PUT", valid, { authorization }), env)).status, 401);
  }
  assert.equal((await worker.fetch(request("PUT", valid), { ...env, EXPIRES: "0" })).status, 403);
  assert.equal(
    (await worker.fetch(request("PUT", valid, {}, "/presentation?prefix=production"), env)).status,
    404,
  );
  assert.equal(
    (await worker.fetch(request("PUT", valid, { "x-cove-country": "../" }), env)).status,
    400,
  );
  const invalid = JSON.stringify({
    ...JSON.parse(valid),
    displayBooks: [{ offer: { amount: 100 } }],
  });
  assert.equal((await worker.fetch(request("PUT", invalid), env)).status, 400);
  assert.equal(
    (await worker.fetch(request("PUT", valid, { "content-length": "1" }), env)).status,
    413,
  );
  assert.equal(objects.size, 0);
  assert.equal(kv.size, 0);
  assert.equal((await worker.fetch(request("PUT", valid), env)).status, 204);
  const key = "campaign/45552506145/synthetic/private/presentation/v2/home/US.json";
  assert.deepEqual([...objects.keys()], [key]);
  assert.deepEqual([...kv.keys()], [key]);
  assert.equal(await (await worker.fetch(request("GET"), env)).text(), valid);
  assert.equal((await worker.fetch(request("DELETE"), env)).status, 403);
  const cleanup = { ...env, PURPOSE: "cleanup" };
  const ready = await worker.fetch(request("POST"), cleanup);
  assert.equal(ready.status, 405);
  assert.equal(ready.headers.get("x-cove-stage-storage-instance"), env.INSTANCE);
  assert.equal((await worker.fetch(request("PUT", valid), cleanup)).status, 403);
  assert.equal((await worker.fetch(request("DELETE"), cleanup)).status, 204);
  assert.equal((await worker.fetch(request("DELETE"), cleanup)).status, 204);
  assert.equal(objects.size, 0);
  assert.equal(kv.size, 0);
});
