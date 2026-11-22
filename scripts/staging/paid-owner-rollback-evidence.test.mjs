import assert from "node:assert/strict";
import { test } from "node:test";
import {
  paidOwnerRollbackEvidence,
  readPaidOwnerFence,
  PAID_QA_PRIMARY,
} from "./paid-owner-rollback-evidence.mjs";
import { QA_PAID_D1, PRODUCTION_D1 } from "./paid-qa-cloudflare-credentials.mjs";

const runId = "44942070208-1",
  journalVersion = "a".repeat(64);
const name = "cove-paid-legal-owner-" + runId;
const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
function fixture(patch = {}, dependencies = {}) {
  const state = {
    version: a,
    revision: "A",
    epoch: "0",
    namespace: "d".repeat(32),
    db: PAID_QA_PRIMARY,
    writes: [],
    ...patch,
  };
  const api = async (method, path, body) => {
    assert.ok(
      path === "/workers/scripts/" + name ||
        path.startsWith("/workers/scripts/" + name + "/"),
      "Rollback may never query or mutate production or other QA Workers",
    );
    if (method === "POST") {
      state.writes.push({ method, path, body });
      assert.equal(path, "/workers/scripts/" + name + "/deployments");
      assert.equal(body.versions.length, 1);
      assert.ok([a, b].includes(body.versions[0].version_id));
      assert.equal(body.versions[0].percentage, 100);
      assert.deepEqual(body.code_update_strategy, { mode: "immediate" });
      state.version = body.versions[0].version_id;
      state.revision = state.version === a ? "A" : "B";
      return {};
    }
    assert.equal(method, "GET");
    if (path.endsWith("/deployments")) {
      const id = state.version;
      return {
        deployments: [
          {
            strategy: "percentage",
            versions: [
              {
                version_id: id,
                percentage: 100,
              },
            ],
          },
        ],
      };
    }
    if (path.endsWith("/subdomain")) return { enabled: false, previews_enabled: false };
    assert.ok(path.startsWith("/workers/scripts/" + name + "/versions/"));
    const id = path.split("/").at(-1),
      phase = id === a ? "A" : "B";
    return {
      id,
      resources: {
        bindings: [
          { type: "d1", name: "PRIMARY_DB", database_id: state.db },
          {
            type: "durable_object_namespace",
            name: "LEGAL_AUTHORITY",
            class_name: "CoveLegalAuthority",
            namespace_id: state.namespace,
          },
          ...Object.entries({
            COVE_QA_OWNER_JOURNAL_VERSION: journalVersion,
            COVE_QA_OWNER_REHEARSAL_REVISION: phase,
            COVE_RIGHTS_OWNER_PRIMARY_ID: PAID_QA_PRIMARY,
          }).map(([name, text]) => ({ type: "plain_text", name, text })),
        ],
      },
    };
  };
  const post = async (route, { challenge }) => {
    assert.equal(route, "/qa/current-mutation-fence");
    return {
      status: state.fenceStatus || 200,
      body: {
        schema: "cove.qa.current-owner-sql-journal.v1",
        journalVersion,
        primaryId: state.fencePrimary || PAID_QA_PRIMARY,
        authorizing: false,
        tables: 24,
        triggers: 78,
        mutationEpoch: state.epoch,
        rehearsalRevision: state.revision,
        challenge: state.stale ? "0".repeat(32) : challenge,
      },
    };
  };
  const proof = paidOwnerRollbackEvidence({ runId, journalVersion, api, post, ...dependencies });
  return {
    state,
    proof,
    post,
    async stageB() {
      state.version = b;
      state.revision = "B";
      state.epoch = "17";
      await proof.captureB();
    },
  };
}

test("actual isolated QA A/B/A retains denial epoch without claiming production version proof", async () => {
  const f = fixture();
  await f.proof.captureA();
  await f.stageB();
  f.state.epoch = "23";
  await f.proof.restoreA("23");
  const r = await f.proof.verifyRestored("23");
  assert.equal(r.versionA, a);
  assert.equal(r.versionB, b);
  assert.equal(r.denialEpochPreserved, true);
  assert.equal(r.productionRollbackCertified, false);
  assert.equal(r.productionVersionsUnchanged, false);
  assert.equal(r.productionVersionsNotInspected, true);
  assert.equal(r.qaAccountIsolated, true);
  assert.equal(r.releaseCertified, false);
  assert.equal(f.state.writes.length, 1);
});
test("production and stale legacy QA D1 are both rejected before any mutation", async () => {
  assert.equal(PAID_QA_PRIMARY, QA_PAID_D1);
  assert.notEqual(PAID_QA_PRIMARY, PRODUCTION_D1);
  for (const patch of [{ db: PRODUCTION_D1 }, { db: "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e" }]) {
    const f = fixture(patch);
    await assert.rejects(f.proof.captureA());
    assert.equal(f.state.writes.length, 0);
  }
});
test("forged legacy or production primary in live current-denial fence fails closed", async () => {
  for (const fencePrimary of ["7c7ab994-f6b3-419d-a72d-71eb9ea22e7e", PRODUCTION_D1]) {
    const f = fixture({ fencePrimary });
    await assert.rejects(readPaidOwnerFence(f.post, journalVersion, "A"));
    assert.equal(f.state.writes.length, 0);
  }
});
test("namespace replacement and non-distinct B are rejected", async () => {
  const f = fixture();
  await f.proof.captureA();
  await assert.rejects(f.proof.captureB(), /distinct/);
  const g = fixture();
  await g.proof.captureA();
  g.state.namespace = "f".repeat(32);
  await assert.rejects(g.stageB(), /namespace/);
  assert.equal(g.state.writes.length, 0);
});
test("changed durable denial epoch cannot certify rollback", async () => {
  const f = fixture();
  await f.proof.captureA();
  await f.stageB();
  await f.proof.restoreA("17");
  for (const epoch of ["0", "16", "18"]) {
    f.state.epoch = epoch;
    await assert.rejects(f.proof.verifyRestored("17"), /denial epoch/);
  }
});
test("stale receipt, malformed epoch and wrong running revision are rejected", async () => {
  for (const patch of [
    { stale: true },
    { epoch: "9007199254740992" },
    { epoch: "-1" },
    { revision: "B" },
  ]) {
    const f = fixture(patch);
    await assert.rejects(readPaidOwnerFence(f.post, journalVersion, "A"));
  }
});
test("current deployment drift blocks rollback, zero real mutations cannot certify", async () => {
  const f = fixture();
  await f.proof.captureA();
  await f.stageB();
  await assert.rejects(f.proof.restoreA("0"), /actual paid mutation/);
  f.state.version = a;
  await assert.rejects(f.proof.restoreA("17"), /unexpected deployment/);
  assert.equal(f.state.writes.length, 0);
});
test("untrusted run identity cannot select a production worker", () => {
  for (const id of ["cove-persistence-backend", "44942070208-0", "44942070208-1/../../production"])
    assert.throws(() => paidOwnerRollbackEvidence({ runId: id, journalVersion }));
});
test("runtime B is required after independent B metadata, with fresh challenges", async () => {
  let time = 0,
    sleeps = 0;
  const f = fixture(
    {},
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
        sleeps++;
        f.state.revision = "B";
      },
    },
  );
  await f.proof.captureA();
  await assert.rejects(f.proof.waitForRevision("B"), /both immutable/);
  f.state.version = b;
  await f.proof.captureBDeployment();
  const result = await f.proof.waitForRevision("B");
  assert.equal(result.rehearsalRevision, "B");
  assert.equal(sleeps, 1);
  assert.equal(time, 2000);
  assert.equal(f.state.writes.length, 0);
});
test("persistent prior revision produces bounded category evidence rather than silent timeout", async () => {
  let time = 0,
    sleeps = 0;
  const f = fixture(
    {},
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
        sleeps++;
      },
    },
  );
  await f.proof.captureA();
  f.state.version = b;
  await f.proof.captureBDeployment();
  await assert.rejects(
    f.proof.waitForRevision("B"),
    /paid_owner_revision_not_ready:\{"valid_prior_revision":30\}/,
  );
  assert.equal(sleeps, 29);
  assert.ok(time < 60000);
});
test("stale journal/challenge, malformed revision and auth denial fail without readiness retries", async () => {
  for (const patch of [
    { stale: true },
    { epoch: "-1" },
    { revision: "invalid" },
    { fenceStatus: 401 },
  ]) {
    let sleeps = 0;
    const f = fixture(
      {},
      {
        sleep: async () => {
          sleeps++;
        },
      },
    );
    await f.proof.captureA();
    f.state.version = b;
    await f.proof.captureBDeployment();
    Object.assign(f.state, patch);
    await assert.rejects(f.proof.waitForRevision("B"), /paid_owner_revision_invalid_receipt/);
    assert.equal(sleeps, 0);
  }
});
test("503 propagation may recover but can never count as a valid journal receipt", async () => {
  let time = 0;
  const f = fixture(
    {},
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
        f.state.fenceStatus = 200;
        f.state.revision = "B";
      },
    },
  );
  await f.proof.captureA();
  f.state.version = b;
  await f.proof.captureBDeployment();
  f.state.fenceStatus = 503;
  const result = await f.proof.waitForRevision("B");
  assert.equal(result.rehearsalRevision, "B");
  assert.equal(time, 2000);
});
test("both real version transitions explicitly apply immediate DO update to the exact QA owner", async () => {
  const f = fixture();
  await f.proof.captureA();
  f.state.version = b;
  await f.proof.captureBDeployment();
  assert.equal(f.state.writes.length, 0);
  await f.proof.activateBImmediate();
  assert.equal((await f.proof.waitForRevision("B")).rehearsalRevision, "B");
  f.state.epoch = "23";
  await f.proof.captureB();
  await f.proof.restoreA("23");
  assert.equal((await f.proof.waitForRevision("A")).rehearsalRevision, "A");
  assert.equal((await f.proof.verifyRestored("23")).denialEpochPreserved, true);
  assert.equal(f.state.writes.length, 2);
  assert.deepEqual(
    f.state.writes.map((x) => x.body.versions[0].version_id),
    [b, a],
  );
  assert.ok(f.state.writes.every((x) => x.path === "/workers/scripts/" + name + "/deployments"));
});
test("B activation refuses unexpected serving version or unsafe QA D1 before any POST", async () => {
  for (const drift of ["version", "database"]) {
    const f = fixture();
    await f.proof.captureA();
    f.state.version = b;
    await f.proof.captureBDeployment();
    if (drift === "version") f.state.version = a;
    else f.state.db = PRODUCTION_D1;
    await assert.rejects(f.proof.activateBImmediate());
    assert.equal(f.state.writes.length, 0);
  }
});
