import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync("src/features/fore/rights-rechecked-replica-candidates.ts", "utf8");
const search = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { rightsRecheckedReplicaCandidates } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

const replica = { results: [{ product_id: "prd_a", score: 9 }, { product_id: "prd_b", score: 3 }] };
const primary = { results: [{ product_id: "prd_b", score: 20 }] };
const calls = [];
const setup = (overrides = {}) => ({
  enabled: true,
  maxPageSize: 24,
  async selectPrimary() {
    calls.push("primary-rank");
    return primary;
  },
  async selectReplica() {
    calls.push("replica-rank");
    return replica;
  },
  async recheckPrimary(ids) {
    calls.push("primary-rights:" + ids.join(","));
    return ["prd_b", "prd_a"];
  },
  ...overrides,
});

calls.length = 0;
assert.equal(await rightsRecheckedReplicaCandidates(setup({ enabled: false })), primary);
assert.deepEqual(calls, ["primary-rank"], "Off must never query replica or validator");

calls.length = 0;
assert.equal(await rightsRecheckedReplicaCandidates(setup()), replica);
assert.deepEqual(calls, ["replica-rank", "primary-rights:prd_a,prd_b"]);

calls.length = 0;
assert.equal(
  await rightsRecheckedReplicaCandidates(
    setup({
      async recheckPrimary(ids) {
        calls.push("primary-rights:" + ids.join(","));
        return ["prd_b"]; // A was withdrawn or suppressed since the replica snapshot.
      },
    }),
  ),
  primary,
);
assert.deepEqual(calls, [
  "replica-rank",
  "primary-rights:prd_a,prd_b",
  "primary-rank",
]);

for (const results of [
  [],
  [{ product_id: "prd_a" }, { product_id: "prd_a" }],
  [{ product_id: "" }],
  [{ product_id: "x".repeat(129) }],
  [{ product_id: 42 }],
]) {
  calls.length = 0;
  const result = await rightsRecheckedReplicaCandidates(
    setup({ async selectReplica() { calls.push("replica-rank"); return { results }; } }),
  );
  assert.equal(result, primary);
  assert.deepEqual(calls, ["replica-rank", "primary-rank"]);
}

calls.length = 0;
assert.equal(
  await rightsRecheckedReplicaCandidates(
    setup({
      async selectReplica() {
        calls.push("replica-error");
        throw Error("Replica offline");
      },
    }),
  ),
  primary,
);
assert.deepEqual(calls, ["replica-error", "primary-rank"]);

calls.length = 0;
await assert.rejects(
  rightsRecheckedReplicaCandidates(
    setup({
      async recheckPrimary() {
        calls.push("primary-unavailable");
        throw Error("Primary D1 unavailable");
      },
    }),
  ),
  /Primary D1 unavailable/,
);
assert.deepEqual(
  calls,
  ["replica-rank", "primary-unavailable"],
  "Failure to validate cannot authorize a replica candidate or a stale cached book",
);

assert.match(search, /!userId\s*&&\s*input\.subscription === undefined/);
assert.match(search, /input\.library === undefined/);
assert.match(search, /FORE_SEARCH_REPLICA_CANDIDATES === "1"/);
assert.match(search, /const scoped = rightsScopedCachedPageQuery\(part, ids\)/);
assert.match(search, /await env\.DB\.prepare\(scoped\.sql\)/);
assert.match(search, /selectPrimary: \(\) => execute\(env\.DB\)/);
assert.match(search, /searchD1\(env, searchInputForBackend, userId\)/);
console.log("PASS: replica candidate pages are presentation-only; current primary rights are mandatory; stale, empty, invalid and failed snapshots never authorize books");
