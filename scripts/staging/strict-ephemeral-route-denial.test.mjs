import assert from "node:assert/strict";
import { test } from "node:test";
import { requirePrivateVerifierNotFound } from "./strict-ephemeral-route-denial.mjs";

function sequence(statuses, noStore = true) {
  let calls = 0;
  let pauses = 0;
  let cancellations = 0;
  return {
    probe: async () => {
      const status = statuses[Math.min(calls++, statuses.length - 1)];
      return {
        status,
        headers: new Headers({ "cache-control": noStore ? "no-store" : "public" }),
        body: {
          cancel: async () => {
            cancellations++;
          },
        },
      };
    },
    pause: async () => {
      pauses++;
    },
    stats: () => ({ calls, pauses, cancellations }),
  };
}

test("transient 500, 503 and 522 recover only with exact 404/no-store", async () => {
  const x = sequence([500, 503, 522, 404]);
  const response = await requirePrivateVerifierNotFound(x.probe, {
    attempts: 4,
    pause: x.pause,
  });
  assert.equal(response.status, 404);
  assert.deepEqual(x.stats(), { calls: 4, pauses: 3, cancellations: 3 });
});

test("immediate verifier 404 with no-store is accepted without retries", async () => {
  const x = sequence([404]);
  assert.equal((await requirePrivateVerifierNotFound(x.probe)).status, 404);
  assert.deepEqual(x.stats(), { calls: 1, pauses: 0, cancellations: 0 });
});

test("a public 200 and unrelated statuses fail immediately", async () => {
  for (const status of [200, 401, 403, 429]) {
    const x = sequence([status, 404]);
    await assert.rejects(
      requirePrivateVerifierNotFound(x.probe, { pause: x.pause }),
      /disallowed route|exact 404/,
    );
    assert.deepEqual(x.stats(), { calls: 1, pauses: 0, cancellations: 1 });
  }
});

test("a proxy 404 without the verifier no-store marker cannot pass", async () => {
  const x = sequence([404], false);
  await assert.rejects(requirePrivateVerifierNotFound(x.probe), /exact 404/);
  assert.deepEqual(x.stats(), { calls: 1, pauses: 0, cancellations: 1 });
});

test("persistent runtime 500 fails closed after its bounded retry budget", async () => {
  const x = sequence([500]);
  await assert.rejects(
    requirePrivateVerifierNotFound(x.probe, { attempts: 3, pause: x.pause }),
    /never returned exact 404/,
  );
  assert.deepEqual(x.stats(), { calls: 3, pauses: 2, cancellations: 3 });
});

test("network exceptions and invalid retry budgets do not prove denial", async () => {
  await assert.rejects(
    requirePrivateVerifierNotFound(async () => {
      throw Error("private network details");
    }),
    /failed before an HTTP response/,
  );
  for (const attempts of [0, -1, 7, 1.2]) {
    await assert.rejects(
      requirePrivateVerifierNotFound(async () => ({ status: 404 }), { attempts }),
      /Invalid bounded/,
    );
  }
});
