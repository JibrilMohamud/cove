import assert from "node:assert/strict";
import { test } from "node:test";
import {
  paidOwnerRollbackEvidence,
  readPaidOwnerFence,
  PAID_QA_PRIMARY,
} from "./paid-owner-rollback-evidence.mjs";

const runId = "44942070208-1",
  journalVersion = "a".repeat(64);
const name = "cove-paid-legal-owner-" + runId;
const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
function fixture(patch = {}) {
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
    if (method === "POST") {
      state.writes.push({ method, path, body });
      assert.equal(path, "/workers/scripts/" + name + "/deployments");
      assert.deepEqual(body.versions, [{ version_id: a, percentage: 100 }]);
      state.version = a;
      state.revision = "A";
      return {};
    }
    assert.equal(method, "GET");
    if (path.endsWith("/deployments")) {
      const id = path.includes("cove-persistence-backend")
        ? "401f2af2-6e69-4611-8110-1d127af6eecf"
        : path.includes("cove-legal-authority-production")
          ? "3463ff93-f077-40bf-a4d5-fb7bfc143cd5"
          : state.version;
      return {
        deployments: [
          {
            strategy: "percentage",
            versions: [
              {
                version_id: state.prodDrift && path.includes("-production") ? a : id,
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
      status: 200,
      body: {
        schema: "cove.qa.current-owner-sql-journal.v1",
        journalVersion,
        primaryId: PAID_QA_PRIMARY,
        authorizing: false,
        tables: 24,
        triggers: 78,
        mutationEpoch: state.epoch,
        rehearsalRevision: state.revision,
        challenge: state.stale ? "0".repeat(32) : challenge,
      },
    };
  };
  const proof = paidOwnerRollbackEvidence({ runId, journalVersion, api, post });
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

test("actual A/B/A pins, independent production invariance and current epoch are mandatory", async () => {
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
  assert.equal(r.releaseCertified, false);
  assert.equal(f.state.writes.length, 1);
});
test("production D1 or production-version drift blocks capture before any POST", async () => {
  for (const patch of [{ db: "4bd657ac-8789-403e-a28c-93aba8d0a989" }, { prodDrift: true }]) {
    const f = fixture(patch);
    await assert.rejects(f.proof.captureA());
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
