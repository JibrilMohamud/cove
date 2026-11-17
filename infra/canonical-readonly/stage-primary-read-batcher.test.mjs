import assert from "node:assert/strict";
import { test } from "node:test";
import { createStagePrimaryReadBatcher } from "./stage-primary-read-batcher.mjs";

const statement = (n) => ({ sql: "SELECT ? AS rights", params: [n] });

test("32 independent primary reads use bounded provider batches and keep response slices private", async () => {
  const read = createStagePrimaryReadBatcher({ windowMs: 3 });
  const groups = [];
  const execute = async (batch) => {
    groups.push(batch.map((x) => x.params[0]));
    return batch.map((x) => ({ results: [{ rights: x.params[0] }], meta: { served_by_primary: true } }));
  };
  const result = await Promise.all(
    Array.from({ length: 32 }, (_, i) => read([statement(i)], execute)),
  );
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map((g) => g.length), [8, 8, 8, 8]);
  assert.deepEqual(result.map((rows) => rows[0].results[0].rights), Array.from({ length: 32 }, (_, i) => i));
});

test("multi-statement requests stay contiguous and are returned in original order", async () => {
  const read = createStagePrimaryReadBatcher({ windowMs: 3 });
  const execute = async (batch) => batch.map((s) => ({ n: s.params[0] }));
  const [a, b, c] = await Promise.all([
    read([statement(1), statement(2)], execute),
    read([statement(3)], execute),
    read([statement(4), statement(5)], execute),
  ]);
  assert.deepEqual([a, b, c], [[{ n: 1 }, { n: 2 }], [{ n: 3 }], [{ n: 4 }, { n: 5 }]]);
});

test("every fresh request reexecutes SQL after a revocation; never reuse positive results", async () => {
  const read = createStagePrimaryReadBatcher({ windowMs: 1 });
  let rights = 1;
  let calls = 0;
  const execute = async (batch) => { calls++; return batch.map(() => ({ rights })); };
  assert.equal((await read([statement(1)], execute))[0].rights, 1);
  rights = 0;
  assert.equal((await read([statement(1)], execute))[0].rights, 0);
  assert.equal(calls, 2);
});

test("upstream error rejects every grouped caller and does not poison later requests", async () => {
  const read = createStagePrimaryReadBatcher({ windowMs: 1 });
  const all = await Promise.allSettled([
    read([statement(1)], async () => { throw new Error("provider-sensitive-text"); }),
    read([statement(2)], async () => [{ results: [] }]),
  ]);
  assert.deepEqual(all.map((x) => x.status), ["rejected", "rejected"]);
  for (const x of all) assert.doesNotMatch(x.reason.message, /provider-sensitive-text/);
  assert.deepEqual(await read([statement(3)], async (batch) => batch), [statement(3)]);
});

test("partial provider response must fail the entire batch without a rights-positive partial success", async () => {
  const read = createStagePrimaryReadBatcher({ windowMs: 1 });
  const execute = async () => [{ results: [{ rights: 1 }] }];
  const all = await Promise.allSettled([read([statement(1)], execute), read([statement(2)], execute)]);
  assert.deepEqual(all.map((x) => x.status), ["rejected", "rejected"]);
});

test("invalid request is rejected before entering a legitimate neighboring batch", async () => {
  const read = createStagePrimaryReadBatcher({ windowMs: 1 });
  let calls = 0;
  const execute = async (batch) => { calls++; return batch; };
  const accepted = read([statement(7)], execute);
  await assert.rejects(read([{ sql: "", params: [] }], execute));
  await assert.rejects(read([statement("a".repeat(600_000))], execute));
  assert.deepEqual(await accepted, [statement(7)]);
  assert.equal(calls, 1);
});

test("bounded byte and statement limits keep large valid logical reads independent", async () => {
  const read = createStagePrimaryReadBatcher({ windowMs: 3, maxStatements: 3 });
  const calls = [];
  const execute = async (batch) => { calls.push(batch.length); return batch; };
  const [a, b] = await Promise.all([
    read([statement(1), statement(2), statement(3), statement(4)], execute),
    read([statement(5)], execute),
  ]);
  assert.equal(a.length, 4);
  assert.equal(b.length, 1);
  assert.deepEqual(calls.sort(), [1, 4]);
});
