import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedPresentationReader } from "./isolated-presentation-read.mjs";

const scope = {
  readToken: "test-fixture-credential-000000000000",
  source: "15ce2ea3-17f8-4d99-9015-a78a6a3af05d",
  sourceName: "cove-real-catalog-snapshot-20261125",
};
const success = (rows = [{ value: 1 }], meta = {}) =>
  Response.json({
    success: true,
    result: [
      {
        success: true,
        results: rows,
        meta: { changed_db: false, changes: 0, rows_written: 0, ...meta },
      },
    ],
  });
test("isolated preparation allows scalar replace but rejects writes and foreign batches before network", async () => {
  let calls = 0;
  const db = createIsolatedPresentationReader({
    ...scope,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/d1/database/${scope.source}/query`,
      );
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, "Bearer " + scope.readToken);
      return success();
    },
  });
  assert.deepEqual(await db.prepare("SELECT replace(?,'-','_') value").bind("a-b").first(), {
    value: 1,
  });
  for (const sql of [
    "REPLACE INTO products VALUES('x')",
    "WITH x AS (SELECT 1) DELETE FROM products",
    "SELECT 1; DELETE FROM products",
    "SELECT load_extension('x')",
    "SELECT 1 /* hidden */",
  ])
    assert.throws(() => db.prepare(sql));
  assert.throws(() => db.batch([{ all: () => success() }]));
  assert.equal(calls, 1);
  assert.throws(() =>
    createIsolatedPresentationReader({ ...scope, source: "4bd657ac-8789-403e-a28c-93aba8d0a989" }),
  );
});
test("provider-throttled SELECT preparation retries finitely and respects Retry-After without changing request", async () => {
  const sleeps = [],
    events = [],
    requests = [];
  const db = createIsolatedPresentationReader({
    ...scope,
    sleep: async (ms) => sleeps.push(ms),
    onDiagnostic: (x) => events.push(x),
    fetchImpl: async (_url, init) => {
      requests.push(init.body);
      return requests.length === 1
        ? Response.json(
            { success: false, errors: [{ code: 7429, message: "sensitive provider text" }] },
            { status: 429, headers: { "retry-after": "25" } },
          )
        : success();
    },
  });
  await db.prepare("SELECT ? value").bind("secret-test-value").all();
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.deepEqual(sleeps, [25000]);
  assert.equal(events[0].httpStatus, 429);
  assert.deepEqual(events[0].providerCodes, [7429]);
  assert.ok(!JSON.stringify(events).includes("sensitive"));
  assert.ok(!JSON.stringify(events).includes("secret-test-value"));
  assert.ok(!JSON.stringify(events).includes(scope.readToken));
});
test("recognized unavailable responses including non-JSON gateways are preparation-only retries", async () => {
  for (const status of [502, 503, 504]) {
    let calls = 0;
    const db = createIsolatedPresentationReader({
      ...scope,
      sleep: async () => {},
      onDiagnostic: () => {},
      fetchImpl: async () =>
        ++calls === 1 ? new Response("gateway unavailable", { status }) : success(),
    });
    await db.prepare("SELECT 1").all();
    assert.equal(calls, 2);
  }
});
test("permission, SQL and malformed 200 errors fail once with sanitized provider diagnostics", async () => {
  for (const status of [200, 400, 401, 403, 500]) {
    let calls = 0;
    const events = [];
    const db = createIsolatedPresentationReader({
      ...scope,
      sleep: async () => assert.fail("Permanent errors must not retry"),
      onDiagnostic: (x) => events.push(x),
      fetchImpl: async () => {
        calls++;
        return status === 200
          ? new Response("invalid JSON")
          : Response.json(
              {
                success: false,
                errors: [{ code: 7500, message: "sensitive SQL or parameter detail" }],
              },
              { status },
            );
      },
    });
    await assert.rejects(
      () => db.prepare("SELECT 1").all(),
      /Isolated presentation preparation failed/,
    );
    assert.equal(calls, 1);
    assert.equal(events[0].httpStatus, status);
    assert.ok(!JSON.stringify(events).includes("sensitive"));
  }
});
test("persistent overload stops at four attempts and excessive Retry-After is never ignored", async () => {
  for (const header of [null, "61"]) {
    let calls = 0;
    const db = createIsolatedPresentationReader({
      ...scope,
      sleep: async () => {},
      onDiagnostic: () => {},
      fetchImpl: async () => {
        calls++;
        return Response.json(
          { success: false, errors: [{ code: 7429 }] },
          { status: 429, headers: header ? { "retry-after": header } : {} },
        );
      },
    });
    await assert.rejects(() => db.prepare("SELECT 1").all());
    assert.equal(calls, header ? 1 : 4);
  }
});
test("source mutation evidence, absent metadata and transport exceptions never become successful reads", async () => {
  for (const fetchImpl of [
    async () => success([], { changed_db: true }),
    async () => success([], { rows_written: 1 }),
    async () => Response.json({ success: true, result: [{ success: true, results: [] }] }),
    async () => {
      throw Error("private transport detail");
    },
  ]) {
    const events = [];
    const db = createIsolatedPresentationReader({
      ...scope,
      fetchImpl,
      onDiagnostic: (x) => events.push(x),
    });
    await assert.rejects(() => db.prepare("SELECT 1").all());
    assert.ok(!JSON.stringify(events).includes("private transport detail"));
  }
});
