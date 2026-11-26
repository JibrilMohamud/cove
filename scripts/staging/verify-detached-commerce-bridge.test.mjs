import assert from "node:assert/strict";
import { test } from "node:test";
import bridge from "./detached-commerce-owner-bridge.mjs";
import { verifyDetachedBridge } from "./verify-detached-commerce-bridge.mjs";

const gate = "a".repeat(64);
const instance = "b".repeat(32);
const origin = "https://detached.example.invalid";
const env = {
  GATE: gate,
  OWNER_SECRET: "c".repeat(64),
  BRIDGE_INSTANCE: instance,
  EXPIRES: String(Date.now() + 60_000),
  LEGAL_PRIVATE: { fetch: () => assert.fail("readiness or denied request called owner") },
};
const request = (url, init) => bridge.fetch(new Request(url, init), env);
const verify = (fetcher, attempts = 2) =>
  verifyDetachedBridge({ origin, gate, instance, fetcher, attempts, pause: async () => {} });

test("bridge proves readiness and denies both invalid credentials", async () => {
  const result = await verify(request);
  assert.equal(result["authorized:204:instance"], 1);
  assert.equal(result["anonymous:401:instance"], 1);
  assert.equal(result["invalid:401:instance"], 1);
  assert.equal(result["authorized-confirmation:204:instance"], 1);
  for (const headers of [{}, { authorization: "Bearer " + "d".repeat(64) }]) {
    const response = await request(origin + "/publish", { method: "POST", headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("x-cove-qa-bridge-instance"), instance);
  }
});

test("provider 404 requires a new complete verified sequence", async () => {
  let calls = 0;
  const result = await verify((url, init) => {
    if (++calls === 2) return Promise.resolve(new Response(null, { status: 404 }));
    return request(url, init);
  });
  assert.equal(result["anonymous:404:unverified"], 1);
  assert.equal(result["anonymous:401:instance"], 1);
  assert.equal(result["authorized:204:instance"], 2);
});

test("persistent anonymous 404 or unmarked 401 cannot certify denial", async () => {
  for (const status of [404, 401]) {
    await assert.rejects(
      verify((url, init) =>
        init.headers.authorization
          ? request(url, init)
          : Promise.resolve(new Response(null, { status })),
      ),
      /readiness\/authorization unverified/,
    );
  }
});

test("unauthorized success fails immediately even without a marker", async () => {
  let calls = 0;
  await assert.rejects(
    verify((url, init) => {
      calls++;
      return init.headers.authorization
        ? request(url, init)
        : Promise.resolve(new Response(null, { status: 204 }));
    }),
    /accepted unauthorized/,
  );
  assert.equal(calls, 2);
});

test("matching bridge marker with wrong denial status fails, not retries", async () => {
  await assert.rejects(
    verify((url, init) =>
      init.headers.authorization
        ? request(url, init)
        : Promise.resolve(
            new Response(null, {
              status: 404,
              headers: { "x-cove-qa-bridge-instance": instance, "cache-control": "no-store" },
            }),
          ),
    ),
    /anonymous status mismatch/,
  );
});

test("expired bridge remains fail-closed and cannot issue a readiness receipt", async () => {
  const expired = { ...env, EXPIRES: String(Date.now() - 1) };
  const response = await bridge.fetch(
    new Request(origin + "/ready", { headers: { authorization: "Bearer " + gate } }),
    expired,
  );
  assert.equal(response.status, 503);
});
