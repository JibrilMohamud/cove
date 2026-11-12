import assert from "node:assert/strict";
import { test } from "node:test";
import { requireOwnedCanaryDenial } from "./strict-owned-canary-denial.mjs";

function sequence(statuses) {
  let calls = 0;
  let cancellations = 0;
  let pauses = 0;
  return {
    probe: async () => ({
      status: statuses[Math.min(calls++, statuses.length - 1)],
      body: {
        cancel: async () => {
          cancellations++;
        },
      },
      headers: new Headers({ "cache-control": "no-store" }),
    }),
    pause: async () => {
      pauses++;
    },
    stats: () => ({ calls, cancellations, pauses }),
  };
}

test("edge 522/503/404 may recover, but only exact 401 proves denial", async () => {
  const x = sequence([522, 503, 404, 401]);
  const response = await requireOwnedCanaryDenial(x.probe, { attempts: 4, pause: x.pause });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(x.stats(), { calls: 4, cancellations: 3, pauses: 3 });
});

test("immediate 401 is not retried or drained before header assertions", async () => {
  const x = sequence([401]);
  assert.equal((await requireOwnedCanaryDenial(x.probe, { pause: x.pause })).status, 401);
  assert.deepEqual(x.stats(), { calls: 1, cancellations: 0, pauses: 0 });
});

test("unsafe public 200 and unrelated failures stop without retries", async () => {
  for (const status of [200, 403, 429, 500]) {
    const x = sequence([status, 401]);
    await assert.rejects(
      requireOwnedCanaryDenial(x.probe, { pause: x.pause }),
      /public content|required HTTP 401/,
    );
    assert.deepEqual(x.stats(), { calls: 1, cancellations: 1, pauses: 0 });
  }
});

test("persistent 522 fails closed after bounded retry budget", async () => {
  const x = sequence([522]);
  await assert.rejects(
    requireOwnedCanaryDenial(x.probe, { attempts: 3, pause: x.pause }),
    /never returned exact HTTP 401/,
  );
  assert.deepEqual(x.stats(), { calls: 3, cancellations: 3, pauses: 2 });
});

test("failed network probes and invalid budgets cannot pass security", async () => {
  let called = 0;
  await assert.rejects(
    requireOwnedCanaryDenial(async () => {
      called++;
      throw Error("private error");
    }),
    /failed before receiving/,
  );
  assert.equal(called, 1);
  for (const attempts of [0, -1, 7, 1.2]) {
    await assert.rejects(
      requireOwnedCanaryDenial(
        async () => {
          called++;
          return { status: 401 };
        },
        { attempts },
      ),
      /Invalid bounded/,
    );
  }
  assert.equal(called, 1);
});
