import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

export const PAID_QA_PRIMARY = "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const productionPins = {
  "cove-persistence-backend": "401f2af2-6e69-4611-8110-1d127af6eecf",
  "cove-legal-authority-production": "3463ff93-f077-40bf-a4d5-fb7bfc143cd5",
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Fresh challenge over the private QA service, never an authorization proof. */
export async function readPaidOwnerFence(post, journalVersion, revision) {
  const challenge = randomBytes(16).toString("hex");
  const response = await post("/qa/current-mutation-fence", { challenge });
  assert.equal(response.status, 200, "current paid-owner journal must be available");
  const r = response.body;
  assert.equal(r?.schema, "cove.qa.current-owner-sql-journal.v1");
  assert.equal(r.challenge, challenge, "stale or substituted challenge receipt");
  assert.equal(r.journalVersion, journalVersion);
  assert.equal(r.primaryId, PAID_QA_PRIMARY);
  assert.equal(r.authorizing, false);
  assert.equal(r.tables, 24);
  assert.equal(r.triggers, 78);
  assert.match(r.mutationEpoch, /^(?:0|[1-9][0-9]{0,15})$/);
  assert.ok(Number.isSafeInteger(Number(r.mutationEpoch)));
  assert.ok(r.rehearsalRevision === "A" || r.rehearsalRevision === "B");
  assert.equal(r.rehearsalRevision, revision, "paid_owner_revision_not_current");
  return r;
}

/** Only the exact run's synthetic owner can receive a deployment POST. */
export function paidOwnerRollbackEvidence({
  runId,
  ownerName,
  journalVersion,
  api,
  post,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  assert.match(runId, /^\d{8,15}-[1-9]\d{0,4}$/);
  assert.match(journalVersion, /^[a-f0-9]{64}$/);
  assert.ok(ownerName === undefined || ownerName === "cove-paid-isolated-owner");
  const name = ownerName || "cove-paid-legal-owner-" + runId;
  const path = "/workers/scripts/" + name;
  let versionA, versionB, namespace, initialEpoch;
  async function current(worker) {
    assert.ok(worker === name || Object.hasOwn(productionPins, worker));
    const list = await api("GET", "/workers/scripts/" + worker + "/deployments");
    const d = list?.deployments?.[0];
    assert.equal(d?.strategy, "percentage");
    assert.equal(d.versions.length, 1);
    assert.equal(d.versions[0].percentage, 100);
    assert.match(d.versions[0].version_id, uuid);
    return d.versions[0].version_id;
  }
  async function unchangedProduction() {
    for (const [worker, expected] of Object.entries(productionPins))
      assert.equal(await current(worker), expected, "production version drift: " + worker);
  }
  async function shape(version, revision) {
    const metadata = await api("GET", path + "/versions/" + version);
    assert.equal(metadata.id, version);
    const bindings = metadata.resources?.bindings || [];
    const db = bindings.filter((b) => b.type === "d1");
    assert.equal(db.length, 1);
    assert.equal(db[0].name, "PRIMARY_DB");
    assert.equal(db[0].database_id, PAID_QA_PRIMARY, "no production D1 binding");
    const objects = bindings.filter((b) => b.type === "durable_object_namespace");
    assert.equal(objects.length, 1);
    assert.equal(objects[0].name, "LEGAL_AUTHORITY");
    assert.equal(objects[0].class_name, "CoveLegalAuthority");
    assert.ok(!objects[0].script_name || objects[0].script_name === name);
    assert.match(objects[0].namespace_id, /^[a-f0-9]{32}$/);
    if (namespace) assert.equal(objects[0].namespace_id, namespace, "owner namespace replaced");
    namespace = objects[0].namespace_id;
    const vars = Object.fromEntries(
      bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text]),
    );
    assert.equal(vars.COVE_QA_OWNER_JOURNAL_VERSION, journalVersion);
    assert.equal(vars.COVE_QA_OWNER_REHEARSAL_REVISION, revision);
    assert.equal(vars.COVE_RIGHTS_OWNER_PRIMARY_ID, PAID_QA_PRIMARY);
    const subdomain = await api("GET", path + "/subdomain");
    assert.equal(subdomain.enabled, false, "private owner must have no public ingress");
    assert.equal(subdomain.previews_enabled, false);
  }
  return {
    async captureA() {
      assert.equal(versionA, undefined);
      await unchangedProduction();
      versionA = await current(name);
      await shape(versionA, "A");
      initialEpoch = (await readPaidOwnerFence(post, journalVersion, "A")).mutationEpoch;
    },
    async captureB() {
      assert.ok(versionA);
      if (!versionB) await this.captureBDeployment();
      assert.equal(await current(name), versionB);
      await shape(versionB, "B");
      const r = await readPaidOwnerFence(post, journalVersion, "B");
      assert.ok(BigInt(r.mutationEpoch) >= BigInt(initialEpoch), "B lost owner history");
      await unchangedProduction();
      return r;
    },
    async captureBDeployment() {
      assert.ok(versionA && !versionB);
      versionB = await current(name);
      assert.notEqual(versionB, versionA, "B must be an actual distinct Worker version");
      await shape(versionB, "B");
      await unchangedProduction();
    },
    async activateBImmediate() {
      assert.ok(versionA && versionB);
      assert.equal(await current(name), versionB, "unexpected deployment before B activation");
      await unchangedProduction();
      // Active DOs now defer code changes by default. Apply this policy to
      // this exact synthetic deployment only; it is not inherited by rollback.
      await api("POST", path + "/deployments", {
        strategy: "percentage",
        versions: [{ version_id: versionB, percentage: 100 }],
        code_update_strategy: { mode: "immediate" },
        annotations: { "workers/message": "Protected synthetic paid-owner B activation" },
      });
      assert.equal(await current(name), versionB);
    },
    async waitForRevision(revision) {
      assert.ok(revision === "A" || revision === "B");
      assert.ok(versionA && versionB, "both immutable versions must be captured first");
      const end = now() + 60_000,
        counts = {};
      for (let attempt = 0; attempt < 30 && now() < end; attempt++) {
        let status;
        try {
          return await readPaidOwnerFence(
            async (route, body) => {
              const response = await post(route, body);
              status = response.status;
              return response;
            },
            journalVersion,
            revision,
          );
        } catch (error) {
          // Only an authenticated, otherwise valid prior revision or route
          // propagation status may be retried. Corrupt/stale proofs fail now.
          const pending =
            status === 200 && error?.message?.startsWith("paid_owner_revision_not_current");
          const reason = pending
            ? "valid_prior_revision"
            : status === 404
              ? "route_404"
              : status === 503
                ? "unavailable_503"
                : null;
          if (!reason) throw Error("paid_owner_revision_invalid_receipt");
          counts[reason] = (counts[reason] || 0) + 1;
        }
        if (attempt < 29 && now() < end) await sleep(Math.min(2000, end - now()));
      }
      throw Error("paid_owner_revision_not_ready:" + JSON.stringify(counts));
    },
    async restoreA(denialEpoch) {
      assert.ok(versionA && versionB);
      assert.ok(BigInt(denialEpoch) > BigInt(initialEpoch), "no actual paid mutation evidence");
      assert.equal(await current(name), versionB, "unexpected deployment before rollback");
      await unchangedProduction();
      await api("POST", path + "/deployments", {
        strategy: "percentage",
        versions: [{ version_id: versionA, percentage: 100 }],
        code_update_strategy: { mode: "immediate" },
        annotations: {
          "workers/message": "Protected synthetic paid-owner rollback; preserve denial state",
        },
      });
      assert.equal(await current(name), versionA, "version A not restored to 100%");
      await shape(versionA, "A");
      // Caller performs bounded propagation readiness before this challenge.
    },
    async verifyRestored(denialEpoch) {
      const r = await readPaidOwnerFence(post, journalVersion, "A");
      assert.equal(r.mutationEpoch, denialEpoch, "rollback changed the durable denial epoch");
      assert.equal(await current(name), versionA);
      await unchangedProduction();
      return {
        schema: "cove.qa.paid-owner-state-rollback.v1",
        versionA,
        versionB,
        namespacePreserved: true,
        denialEpochPreserved: true,
        productionVersionsUnchanged: true,
        productionRollbackCertified: false,
        releaseCertified: false,
      };
    },
  };
}
