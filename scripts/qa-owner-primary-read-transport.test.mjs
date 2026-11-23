import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QA_OWNER_PRIMARY_READ_ROUTE,
  QA_OWNER_PRIMARY_READ_SCHEMA,
  checkedQaOwnerReadSql,
  checkedQaOwnerReadParams,
  createQaOwnerReadOnlyD1,
  serveQaOwnerPrimaryRead,
} from "../src/storefront-strangler/qa-owner-primary-read-transport.mjs";

const SECRET = "a".repeat(64);
let reads = 0,
  writes = 0,
  batches = 0;
function ownerDb() {
  const prepare = (sql, args = []) => ({
    bind(...params) {
      return prepare(sql, params);
    },
    async first() {
      reads++;
      return { ok: 1, firstParam: args[0] ?? null };
    },
    async all() {
      reads++;
      return { results: [{ ok: 1, sql, firstParam: args[0] ?? null }], success: true, meta: {} };
    },
    async run() {
      writes++;
      throw Error("native_write_must_never_be_reached");
    },
  });
  return {
    prepare,
    async batch(items) {
      batches++;
      return Promise.all(items.map((x) => x.all()));
    },
  };
}
function leasedOwner(db = ownerDb()) {
  return {
    async fetch(req) {
      return serveQaOwnerPrimaryRead(req, db, SECRET, true);
    },
  };
}
function request(ops, { secret = SECRET, path = QA_OWNER_PRIMARY_READ_ROUTE } = {}) {
  return new Request("https://cove-owner.internal" + path, {
    method: "POST",
    headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
    body: JSON.stringify({ schema: QA_OWNER_PRIMARY_READ_SCHEMA, ops }),
  });
}
test("a caller with no D1 binding executes parameterized first()/all() only through the QA owner", async () => {
  reads = 0;
  writes = 0;
  const remote = createQaOwnerReadOnlyD1(leasedOwner(), SECRET);
  assert.equal(
    await remote
      .prepare("SELECT 1")
      .first()
      .then((x) => x.ok),
    1,
  );
  const statement = remote.prepare("SELECT title FROM books WHERE id=?").bind("own_1");
  const result = await statement.all();
  assert.equal(result.results[0].firstParam, "own_1");
  assert.equal(result.success, true);
  assert.equal(reads, 2);
  assert.equal(writes, 0);
  assert.equal(Object.hasOwn(remote, "DB"), false);
  assert.equal(Object.hasOwn(remote, "PRIMARY_DB"), false);
});
test("verified all() batches preserve server D1 read batch, never allow foreign statements", async () => {
  batches = 0;
  writes = 0;
  const db = createQaOwnerReadOnlyD1(leasedOwner(), SECRET);
  const a = db.prepare("SELECT 1");
  const b = db.prepare("SELECT name FROM works WHERE id=?").bind("w_1");
  const result = await db.batch([a, b]);
  assert.equal(result.length, 2);
  assert.equal(result[1].results[0].firstParam, "w_1");
  assert.equal(batches, 1);
  assert.equal(writes, 0);
  await assert.rejects(db.batch([{}]), /qa_owner_read_denied/);
  await assert.rejects(db.batch([]), /qa_owner_read_denied/);
  await assert.rejects(db.batch(Array(25).fill(a)), /qa_owner_read_denied/);
});
test("reject DML, CTEs, SQL comments, stacked queries, administrative statements and malformed params", () => {
  const attempts = [
    "INSERT INTO qa_probe_rows VALUES(1)",
    "UPDATE qa_probe_rows SET status='active'",
    "DELETE FROM qa_probe_rows",
    "REPLACE INTO qa_probe_rows VALUES(1)",
    "WITH change AS (DELETE FROM entitlement) SELECT * FROM change",
    "PRAGMA writable_schema=ON",
    "EXPLAIN SELECT * FROM users",
    "SELECT 1; DROP TABLE qa_probe_rows",
    "SELECT 1 -- comment",
    "SELECT 1 /* hidden UPDATE */",
    "SELECT load_extension('bad')",
    "SELECT x FROM t WHERE y='UPDATE'",
    "  \n  ",
  ];
  for (const sql of attempts)
    assert.throws(() => checkedQaOwnerReadSql(sql), /qa_owner_read_denied/, sql);
  for (const params of [[Infinity], [NaN], [{}], [[1, 2]], Array(65).fill(1), ["x".repeat(9000)]])
    assert.throws(() => checkedQaOwnerReadParams(params), /qa_owner_read_denied/);
  const d = createQaOwnerReadOnlyD1(leasedOwner(), SECRET);
  for (const sql of attempts) assert.throws(() => d.prepare(sql), /qa_owner_read_denied/);
  assert.throws(() => d.prepare("SELECT 1").bind({ a: 1 }), /qa_owner_read_denied/);
});
test("no raw D1, mutating run, exec or faux first-primary session can escape", () => {
  const d = createQaOwnerReadOnlyD1(leasedOwner(), SECRET);
  assert.throws(() => d.prepare("SELECT 1").run(), /qa_owner_read_denied/);
  assert.throws(() => d.prepare("SELECT 1").raw(), /qa_owner_read_denied/);
  assert.throws(() => d.exec("SELECT 1"), /qa_owner_read_denied/);
  assert.throws(() => d.withSession("first-primary"), /qa_owner_read_denied/);
  assert.throws(
    () => createQaOwnerReadOnlyD1({ fetch: async () => {} }, "wrong"),
    /qa_owner_read_denied/,
  );
});
test("denied lease, wrong secret, wrong path, wrong method, malformed schemas fail before native D1", async () => {
  reads = 0;
  writes = 0;
  const db = ownerDb();
  const ops = [{ sql: "SELECT 1", params: [], mode: "first" }];
  assert.equal((await serveQaOwnerPrimaryRead(request(ops), db, SECRET, false)).status, 503);
  assert.equal(
    (await serveQaOwnerPrimaryRead(request(ops, { secret: "b".repeat(64) }), db, SECRET, true))
      .status,
    401,
  );
  assert.equal(
    (await serveQaOwnerPrimaryRead(request(ops, { path: "/api/rights/grant" }), db, SECRET, true))
      .status,
    404,
  );
  const invalid = new Request("https://cove-owner.internal" + QA_OWNER_PRIMARY_READ_ROUTE, {
    method: "POST",
    headers: { authorization: "Bearer " + SECRET, "content-type": "application/json" },
    body: JSON.stringify({ schema: QA_OWNER_PRIMARY_READ_SCHEMA, ops, unexpected: true }),
  });
  assert.equal((await serveQaOwnerPrimaryRead(invalid, db, SECRET, true)).status, 400);
  assert.equal(
    (
      await serveQaOwnerPrimaryRead(
        new Request("https://cove-owner.internal" + QA_OWNER_PRIMARY_READ_ROUTE, {
          method: "GET",
          headers: { authorization: "Bearer " + SECRET },
        }),
        db,
        SECRET,
        true,
      )
    ).status,
    405,
  );
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});
test("negative commands cannot get around protocol with raw requests or mixed batch", async () => {
  reads = 0;
  writes = 0;
  const db = ownerDb();
  const probes = [
    [{ sql: "SELECT 1", params: [], mode: "run" }],
    [{ sql: "SELECT 1;UPDATE qa_probe_rows SET status='active'", params: [], mode: "all" }],
    [
      { sql: "SELECT 1", params: [], mode: "first" },
      { sql: "SELECT 2", params: [], mode: "all" },
    ],
    Array(25).fill({ sql: "SELECT 1", params: [], mode: "all" }),
  ];
  const expected = [503, 503, 400, 503];
  for (let i = 0; i < probes.length; i++)
    assert.equal(
      (await serveQaOwnerPrimaryRead(request(probes[i]), db, SECRET, true)).status,
      expected[i],
    );
  assert.equal(writes, 0);
});
test("transport rejects unavailable owner, forged receipt, missing no-store and shape mismatch", async () => {
  const d = createQaOwnerReadOnlyD1(
    {
      async fetch() {
        throw Error("owner_is_down");
      },
    },
    SECRET,
  );
  await assert.rejects(d.prepare("SELECT 1").first(), /owner_is_down/);
  for (const response of [
    Response.json(
      { schema: "cove.qa.owner-primary-read.v1", result: [{ results: [] }] },
      { headers: { "cache-control": "public,max-age=600" } },
    ),
    Response.json(
      { schema: "wrong", result: [{ results: [] }] },
      { headers: { "cache-control": "no-store" } },
    ),
    Response.json(
      { schema: "cove.qa.owner-primary-read.v1", result: [] },
      { headers: { "cache-control": "no-store" } },
    ),
  ]) {
    const d = createQaOwnerReadOnlyD1(
      {
        async fetch() {
          return response.clone();
        },
      },
      SECRET,
    );
    await assert.rejects(d.prepare("SELECT 1").all(), /qa_owner_read_denied/);
  }
});
console.log(
  "PASS: QA-only D1-unbound owner read transport rejects write, forged receipts, unsafe sessions and missing authorization",
);
