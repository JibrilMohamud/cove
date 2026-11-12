import assert from "node:assert/strict";
import { test } from "node:test";
import { requireWorkerCredentialDenial } from "./strict-credential-denial.mjs";

function sequence(statuses) {
  let calls = 0;
  let pauses = 0;
  return {
    probe: async () => ({ status: statuses[Math.min(calls++, statuses.length - 1)] }),
    pause: async () => { pauses++; },
    counts: () => ({ calls, pauses }),
  };
}

test("Workers edge 404/503 can recover but never count as authorization", async () => {
  const state = sequence([404, 503, 401]);
  await requireWorkerCredentialDenial(state.probe, { attempts: 8, pause: state.pause });
  assert.deepEqual(state.counts(), { calls: 3, pauses: 2 });
});

test("forged token 401 is accepted on first attempt", async () => {
  const state = sequence([401]);
  await requireWorkerCredentialDenial(state.probe, { attempts: 8, pause: state.pause });
  assert.deepEqual(state.counts(), { calls: 1, pauses: 0 });
});

test("persistent 404 or 503 does not satisfy the credential gate", async () => {
  for (const status of [404, 503]) {
    const state = sequence([status]);
    await assert.rejects(
      requireWorkerCredentialDenial(state.probe, { attempts: 4, pause: state.pause }),
      /exact Worker-issued 401/,
    );
    assert.deepEqual(state.counts(), { calls: 4, pauses: 3 });
  }
});

test("200, 403 and unrelated failures are immediately rejected", async () => {
  for (const status of [200, 403, 429, 500]) {
    const state = sequence([status, 401]);
    await assert.rejects(
      requireWorkerCredentialDenial(state.probe, { attempts: 8, pause: state.pause }),
      /exact Worker-issued 401/,
    );
    assert.deepEqual(state.counts(), { calls: 1, pauses: 0 });
  }
});

test("unbounded retry inputs fail without making any network request", async () => {
  const state = sequence([401]);
  for (const attempts of [0, -1, 100, 2.5]) {
    await assert.rejects(
      requireWorkerCredentialDenial(state.probe, { attempts, pause: state.pause }),
      /Invalid bounded/,
    );
  }
  assert.deepEqual(state.counts(), { calls: 0, pauses: 0 });
});
