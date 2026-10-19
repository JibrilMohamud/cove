import assert from "node:assert/strict";
import { requireBenchmarkIsolation } from "./performance/benchmark-isolation.mjs";
const own = { id: 17, name: "cloudflare-current-paired", status: "in_progress" };
const old = {
  id: 19,
  name: "cloudflare-obsolete-paired",
  status: "in_progress",
  head_sha: "a".repeat(40),
  head_branch: "old",
};
const ledger = [];
let inventory = [own];
const fetchImpl = async (url, options) => {
  assert.match(
    url,
    /^https:\/\/api.github.com\/repos\/JibrilMohamud\/cove\/actions\/runs\?status=in_progress&per_page=100$/,
  );
  assert.equal(options.method, undefined, "Inventory must only read");
  return {
    ok: true,
    json: async () => ({ total_count: inventory.length, workflow_runs: inventory }),
  };
};
const input = { token: "test-only", runId: 17, fetchImpl };
await requireBenchmarkIsolation(input, ledger);
assert.equal(ledger[0].verified, true);
inventory = [own, old];
await assert.rejects(
  requireBenchmarkIsolation(input, ledger),
  /Competing performance campaign active: 19/,
);
assert.equal(ledger[1].verified, false);
assert.equal(ledger[1].peers[0].sha, "a".repeat(40));
inventory = [own, { ...old, status: "completed" }];
await requireBenchmarkIsolation(input, ledger);
await assert.rejects(requireBenchmarkIsolation({ ...input, token: "" }, ledger), /requires/);
await assert.rejects(
  requireBenchmarkIsolation(
    { ...input, fetchImpl: async () => ({ ok: false, status: 403 }) },
    ledger,
  ),
  /Actions status 403/,
);
await assert.rejects(
  requireBenchmarkIsolation(
    {
      ...input,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ total_count: 101, workflow_runs: [] }),
      }),
    },
    ledger,
  ),
  /complete benchmark/,
);
assert.ok(!JSON.stringify(ledger).includes("test-only"), "Tokens must never appear in evidence");
console.log(
  "PASS: repository-wide competing-run exclusion, current-run allowance, failed inventory, truncation and token privacy",
);
