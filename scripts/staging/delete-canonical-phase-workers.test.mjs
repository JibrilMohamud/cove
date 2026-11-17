import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteOwnedPhaseWorkers, ownedPhaseWorkerNames } from "./delete-canonical-phase-workers.mjs";

const token = "a".repeat(40);
const approved = {
  COVE_PHASE_STAGE_PREFLIGHT_PASSED: "1",
  COVE_PHASE_READER_CREATE_ATTEMPTED: "1",
  COVE_PHASE_SSR_CREATE_ATTEMPTED: "1",
  COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN: token,
};
const pathPrefix =
  "https://api.cloudflare.com/client/v4/accounts/" +
  "d26430caa63ec55f6612e32f36aca5e9/workers/scripts/";

test("only the two exact owned stage names, frontend before read provider", () => {
  assert.deepEqual(ownedPhaseWorkerNames(approved), [
    "cove-storefront-phase-staging",
    "cove-canonical-phase-readonly-staging",
  ]);
  assert.deepEqual(
    ownedPhaseWorkerNames({ ...approved, COVE_PHASE_READER_CREATE_ATTEMPTED: "0" }),
    ["cove-storefront-phase-staging"],
  );
  assert.deepEqual(
    ownedPhaseWorkerNames({ ...approved, COVE_PHASE_SSR_CREATE_ATTEMPTED: "0" }),
    ["cove-canonical-phase-readonly-staging"],
  );
});

test("direct API deletion requires only scoped Workers Scripts Write, never KV", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 204 };
  };
  assert.deepEqual(await deleteOwnedPhaseWorkers(approved, request), { deletedOrAbsent: 2 });
  assert.deepEqual(
    calls.map((x) => x.url),
    [
      pathPrefix + "cove-storefront-phase-staging",
      pathPrefix + "cove-canonical-phase-readonly-staging",
    ],
  );
  for (const { url, options } of calls) {
    assert.equal(options.method, "DELETE");
    assert.equal(options.headers.Authorization, "Bearer " + token);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.ok(!url.includes("?"));
    assert.ok(!url.includes("/storage/kv/"));
  }
});

test("API 200 empty body and already-removed 404 are accepted as idempotent", async () => {
  let calls = 0;
  const result = await deleteOwnedPhaseWorkers(approved, async () => {
    calls += 1;
    return { status: calls === 1 ? 200 : 404, ok: calls === 1 };
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { deletedOrAbsent: 2 });
});

test("incomplete setup attempts are cleaned, but preflight failure never deletes", async () => {
  const onlyReader = {
    ...approved,
    COVE_PHASE_SSR_CREATE_ATTEMPTED: "0",
  };
  assert.deepEqual(ownedPhaseWorkerNames(onlyReader), [
    "cove-canonical-phase-readonly-staging",
  ]);
  const invoke = async () => {
    throw Error("DELETE must not have been called");
  };
  await assert.rejects(
    () =>
      deleteOwnedPhaseWorkers({ ...approved, COVE_PHASE_STAGE_PREFLIGHT_PASSED: "0" }, invoke),
    /Absent-stage preflight/,
  );
  await assert.rejects(
    () =>
      deleteOwnedPhaseWorkers(
        { ...approved, COVE_PHASE_SSR_CREATE_ATTEMPTED: "true" },
        invoke,
      ),
    /Invalid stage creation marker/,
  );
  assert.deepEqual(
    await deleteOwnedPhaseWorkers(
      {
        ...approved,
        COVE_PHASE_READER_CREATE_ATTEMPTED: "0",
        COVE_PHASE_SSR_CREATE_ATTEMPTED: "0",
      },
      invoke,
    ),
    { deletedOrAbsent: 0 },
  );
});

test("permission denial and missing deploy token always fail closed", async () => {
  await assert.rejects(
    () =>
      deleteOwnedPhaseWorkers({ ...approved, COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN: "" }),
    /Scoped stage deploy token absent/,
  );
  let calls = 0;
  await assert.rejects(
    () =>
      deleteOwnedPhaseWorkers(approved, async () => {
        calls += 1;
        return { status: 403, ok: false };
      }),
    /Scoped stage Worker DELETE was denied/,
  );
  assert.equal(calls, 1);
});
