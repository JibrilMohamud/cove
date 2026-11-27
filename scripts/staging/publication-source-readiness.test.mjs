import assert from "node:assert/strict";
import test from "node:test";
import { preparePublicationExport } from "./publication-source-readiness.mjs";

const initial = new Map([
  ["US", 10],
  ["CA", 20],
]);
function fixture(patch = () => {}) {
  let clock = 1000000,
    reads = 0,
    sleeps = 0;
  const options = {
    initial,
    now: () => clock,
    sleep: async (ms) => {
      assert.equal(ms, 2000);
      clock += ms;
      sleeps++;
    },
    read: async () => {
      reads++;
      const result = {
        rows: [
          { country: "US", generation: 11, expires_at: 2000000 },
          { country: "CA", generation: 21, expires_at: 2000000 },
        ],
        state: { available: 2, expected: 2, last_synced: clock },
      };
      patch(result, reads, clock);
      return result;
    },
  };
  return { options, counts: () => ({ reads, sleeps }) };
}
test("backfill's original fresh receipt can expire during deployment; export waits only on read-only fresh source evidence", async () => {
  const h = fixture((r, n, now) => {
    r.state.last_synced = n < 3 ? now - 125000 : now - 5000;
  });
  assert.deepEqual(await preparePublicationExport(h.options), {
    attempts: 3,
    markets: 2,
    sourceAgeMs: 5000,
  });
  assert.deepEqual(h.counts(), { reads: 3, sleeps: 2 });
});
test("30-second preparation margin leaves runtime freshness unchanged and is checked for every export", async () => {
  for (const age of [0, 30000]) {
    const h = fixture((r, _n, now) => {
      r.state.last_synced = now - age;
    });
    const receipt = await preparePublicationExport(h.options);
    assert.equal(receipt.sourceAgeMs, age);
  }
  const h = fixture((r, n, now) => {
    r.state.last_synced = now - (n === 1 ? 30001 : 0);
  });
  assert.equal((await preparePublicationExport(h.options)).attempts, 2);
  assert.equal((await preparePublicationExport(h.options)).attempts, 1);
  assert.equal(h.counts().reads, 3, "No cached preparation receipt");
});
test("incomplete or non-advancing snapshots, stale identities and future clocks cannot authorize export preparation", async () => {
  for (const change of [
    (r) => r.rows.pop(),
    (r) => (r.rows[0].generation = 10),
    (r) => (r.state.available = 1),
    (r) => (r.rows[0].expires_at = 0),
    (r) => (r.state.last_synced = 0),
    (r, _n, now) => (r.state.last_synced = now + 1),
  ]) {
    const h = fixture(change);
    await assert.rejects(
      () => preparePublicationExport(h.options),
      /did not provide fresh complete/,
    );
    assert.deepEqual(h.counts(), { reads: 90, sleeps: 89 });
  }
});
test("read failures are not converted into readiness or replayed as publication calls", async () => {
  const h = fixture();
  h.options.read = async () => {
    throw Error("read unavailable");
  };
  await assert.rejects(() => preparePublicationExport(h.options), /read unavailable/);
  assert.equal(h.counts().sleeps, 0);
});
