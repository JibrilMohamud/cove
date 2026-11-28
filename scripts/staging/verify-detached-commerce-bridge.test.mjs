import assert from "node:assert/strict";
import { test } from "node:test";
import bridge from "./detached-commerce-owner-bridge.mjs";
import { verifyDetachedBridge, publishDetachedBridge } from "./verify-detached-commerce-bridge.mjs";

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
    new Request(origin + "/publish", {
      method: "POST",
      body: "probe:" + instance,
      headers: { authorization: "Bearer " + gate },
    }),
    expired,
  );
  assert.equal(response.status, 503);
});

test("same POST route and framing prove readiness without executing owner calls", async () => {
  await verify((url, init) => {
    assert.equal(url, origin + "/publish");
    assert.equal(init.method, "POST");
    assert.equal(init.body, "probe:" + instance);
    return request(url, init);
  });
});

test("publication rejects empty streams, incorrect instance and overlong payloads", async () => {
  for (const body of ["", "publish:" + "d".repeat(32), "x".repeat(41)]) {
    const response = await request(origin + "/publish", {
      method: "POST",
      body,
      headers: { authorization: "Bearer " + gate },
    });
    assert.equal(response.status, 400);
  }
});

test("exact publish command certifies both fixed products in owner order", async () => {
  const calls = [];
  const published = await bridge.fetch(
    new Request(origin + "/publish", {
      method: "POST",
      body: "publish:" + instance,
      headers: { authorization: "Bearer " + gate },
    }),
    {
      ...env,
      LEGAL_PRIVATE: {
        fetch: async (url, init) => {
          const payload = JSON.parse(init.body);
          calls.push([new URL(url).pathname, payload.productId]);
          assert.equal(init.headers.authorization, "Bearer " + env.OWNER_SECRET);
          return Response.json({ applied: true, epoch: 1 });
        },
      },
    },
  );
  assert.equal(published.status, 204);
  assert.equal(published.headers.get("x-cove-qa-bridge-instance"), instance);
  assert.deepEqual(calls, [
    ["/commercial/publish-verified", "prd_qa_owner_v2_ebook"],
    ["/storefront/publish-commercial", "prd_qa_owner_v2_ebook"],
    ["/commercial/publish-verified", "prd_qa_owner_v2_audio"],
    ["/storefront/publish-commercial", "prd_qa_owner_v2_audio"],
  ]);
});

test("owner refusal exposes only a fixed phase and status and stops publication", async () => {
  let calls = 0;
  const response = await bridge.fetch(
    new Request(origin + "/publish", {
      method: "POST",
      body: "publish:" + instance,
      headers: { authorization: "Bearer " + gate },
    }),
    {
      ...env,
      LEGAL_PRIVATE: {
        fetch: async () => {
          calls++;
          return new Response("private diagnostic", { status: 409 });
        },
      },
    },
  );
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-cove-qa-bridge-phase"), "ebook:rights:409");
  assert.equal(await response.text(), "");
  assert.equal(calls, 1);
});

const publish = (fetcher, attempts = 5) =>
  publishDetachedBridge({ origin, gate, instance, fetcher, attempts, pause: async () => {} });
const marked = (status) =>
  new Response(null, {
    status,
    headers: { "x-cove-qa-bridge-instance": instance, "cache-control": "no-store" },
  });

test("exact hosted failure: readiness then 404, verified incomplete then publish", async () => {
  const calls = [];
  const responses = [new Response(null, { status: 404 }), marked(409), marked(204), marked(204)];
  await publish(async (_url, init) => {
    calls.push(init.body.split(":")[0]);
    return responses.shift();
  });
  assert.deepEqual(calls, ["publish", "verify", "publish", "verify"]);
});

test("lost committed publication response is recovered without another write", async () => {
  const calls = [];
  const responses = [null, new Response(null, { status: 404 }), marked(204)];
  await publish(async (_url, init) => {
    calls.push(init.body.split(":")[0]);
    const response = responses.shift();
    if (!response) throw Error("lost response");
    return response;
  });
  assert.deepEqual(calls, ["publish", "verify", "verify"]);
});

test("unverified readbacks and explicit owner refusal never authorize a replay", async () => {
  let writes = 0;
  await assert.rejects(
    publish(async (_url, init) => {
      if (init.body.startsWith("publish:")) writes++;
      return new Response(null, { status: 404 });
    }, 3),
    /remains unverified/,
  );
  assert.equal(writes, 1);
  await assert.rejects(
    publish(async () => marked(502)),
    /owner publish refused/,
  );
});

test("readback requires the two exact current rights and the two exact offers", async () => {
  const keys = ["ebook", "audio"];
  const rights = keys.map((key) => ({
    product_id: "prd_qa_owner_v2_" + key,
    edition_id: "qa-owner-v2-" + key + "-edition",
    grant_id: "qa-owner-v2-" + key + "-us-retail",
    contract_id: "qa-owner-v2-contract",
    contract_version_id: "qa-owner-v2-contract-v1",
    epoch: 1,
    valid_until: new Date(Date.now() + 60_000).toISOString(),
  }));
  const offers = rights.map((r) => ({
    product_id: r.product_id,
    edition_id: r.edition_id,
    offer_json: JSON.stringify({ type: "purchase", currency: "USD", amountMinor: 100 }),
  }));
  const read = (legal, prices) =>
    bridge.fetch(
      new Request(origin + "/publish", {
        method: "POST",
        headers: { authorization: "Bearer " + gate },
        body: "verify:" + instance,
      }),
      {
        ...env,
        LEGAL_PRIVATE: {
          fetch: async (url, init) => {
            assert.equal(init.headers.authorization, "Bearer " + env.OWNER_SECRET);
            const path = new URL(url).pathname;
            assert.ok(
              ["/commercial/authorize-batch", "/storefront/authorize-batch"].includes(path),
            );
            return path === "/commercial/authorize-batch"
              ? Response.json({ schema: "cove.commercial-legal.v1", rows: legal })
              : Response.json({ schema: "cove.storefront-owner.v1", rows: prices });
          },
        },
      },
    );
  assert.equal((await read(rights, offers)).status, 204);
  assert.equal((await read(rights, offers.slice(0, 1))).status, 409);
  assert.equal((await read([], [])).status, 409);
  assert.equal((await read([], offers)).status, 502);
  assert.equal((await read([rights[0], rights[0]], offers)).status, 502);
  assert.equal(
    (await read([{ ...rights[0], grant_id: "unrelated" }, rights[1]], offers)).status,
    502,
  );
  assert.equal((await read(rights, [{ ...offers[0], offer_json: "{}" }, offers[1]])).status, 502);
});
