import assert from "node:assert/strict";
import { requireBenchmarkIsolation } from "./performance/benchmark-isolation.mjs";
const own = { id: 17, name: "cloudflare-current-paired", status: "in_progress" };
const peer = {
  id: 19,
  name: "cloudflare-obsolete-paired",
  status: "in_progress",
  head_sha: "a".repeat(40),
  head_branch: "old",
};
const ledger = [];
let inventory = [own],
  pageReads = [];
const response = (runs, total = runs.length) => ({
  ok: true,
  status: 200,
  json: async () => ({ total_count: total, workflow_runs: runs }),
});
const fetchImpl = async (url, options) => {
  assert.match(
    url,
    /^https:\/\/api.github.com\/repos\/JibrilMohamud\/cove\/actions\/runs\?status=in_progress&per_page=100&page=[1-4]$/,
  );
  assert.equal(options.method, undefined);
  const page = Number(new URL(url).searchParams.get("page"));
  pageReads.push(page);
  return response(page === 1 ? inventory : []);
};
const input = { token: "test-only", runId: 17, fetchImpl };
await requireBenchmarkIsolation(input, ledger);
assert.equal(ledger.at(-1).verified, true);
assert.deepEqual(pageReads, [1, 2]);
for (const name of [peer.name, "fullsite-performance", "production-storefront-performance"]) {
  inventory = [own, { ...peer, name }];
  await assert.rejects(
    requireBenchmarkIsolation(input, ledger),
    /Competing performance campaign active: 19/,
  );
  assert.equal(ledger.at(-1).verified, false);
}
inventory = [own, { ...peer, status: "completed" }];
await requireBenchmarkIsolation(input, ledger);
await assert.rejects(requireBenchmarkIsolation({ ...input, token: "" }, ledger), /requires/);
await assert.rejects(
  requireBenchmarkIsolation(
    { ...input, fetchImpl: async () => ({ ok: false, status: 403 }) },
    ledger,
  ),
  /Actions status 403/,
);
// A count/list race cannot hide a second page. Read all pages through EOF.
await assert.rejects(
  requireBenchmarkIsolation(
    {
      ...input,
      fetchImpl: async (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        return response(page === 1 ? [own] : page === 2 ? [peer] : [], 5);
      },
    },
    ledger,
  ),
  /Competing performance campaign active: 19/,
);
await requireBenchmarkIsolation(
  {
    ...input,
    fetchImpl: async (url) =>
      response(new URL(url).searchParams.get("page") === "1" ? [own] : [], 5),
  },
  ledger,
);
assert.equal(ledger.at(-1).verified, true);
assert.equal(
  ledger.at(-1).pages.length,
  2,
  "Empty next page proves inventory exhaustion despite a racing count",
);
await assert.rejects(
  requireBenchmarkIsolation({ ...input, fetchImpl: async () => response([]) }, ledger),
  /current run missing/,
);
await assert.rejects(
  requireBenchmarkIsolation({ ...input, fetchImpl: async () => response([own]) }, ledger),
  /within 4 pages/,
);
let attempts = 0;
await requireBenchmarkIsolation(
  {
    ...input,
    fetchImpl: async (...args) => {
      attempts++;
      if (attempts === 1) throw Error("test-only transport message");
      if (attempts === 2) return { ok: false, status: 503 };
      return fetchImpl(...args);
    },
  },
  ledger,
);
assert.equal(ledger.at(-1).verified, true);
assert.equal(attempts, 4);
attempts = 0;
await assert.rejects(
  requireBenchmarkIsolation(
    {
      ...input,
      fetchImpl: async () => {
        attempts++;
        throw Error("test-only");
      },
    },
    ledger,
  ),
  /after 3 attempts/,
);
assert.equal(attempts, 3);
assert.equal(ledger.at(-1).verified, false);
await assert.rejects(
  requireBenchmarkIsolation(
    { ...input, fetchImpl: async () => response(Array(101).fill(own)) },
    ledger,
  ),
  /after 3 attempts/,
);
assert.ok(!JSON.stringify(ledger).includes("test-only"));
console.log(
  "PASS: complete pagination, changing count, hidden second-page peers, missing current run, bounded retries, public campaign exclusion and token privacy",
);
