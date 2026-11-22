import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { QA_WORKERS, QA_PARKED_VERSIONS, createPaidQaControlPlane } from "./paid-qa-isolation.mjs";
export const PARKING_RECEIPT = "artifacts/owner-native-qa/credential-isolation-parking.json";
export async function restorePaidQa(snapshot, api, env = process.env) {
  assert.equal(snapshot.runId, env.GITHUB_RUN_ID + "-" + (env.GITHUB_RUN_ATTEMPT || "1"));
  assert.equal(snapshot.sha, env.GITHUB_SHA);
  assert.match(snapshot.sha || "", /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(snapshot.parked || {}).sort(), Object.values(QA_WORKERS).sort());
  for (const version of Object.values(snapshot.parked))
    assert.match(version, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.deepEqual(snapshot.parked, QA_PARKED_VERSIONS, "paid_qa_unreviewed_parking_version");
  const failures = [];
  for (const [name, version] of Object.entries(snapshot.parked)) {
    const path = "/workers/scripts/" + name;
    // Try both restoration and ingress closure even if either operation fails.
    for (const [suffix, body] of [
      ["/subdomain", { enabled: false, previews_enabled: false }],
      [
        "/deployments",
        { strategy: "percentage", versions: [{ version_id: version, percentage: 100 }] },
      ],
    ]) {
      try {
        await api("POST", path + suffix, body);
      } catch {
        failures.push(name);
      }
    }
    try {
      const d = await api("GET", path + "/deployments");
      assert.deepEqual(d.deployments?.[0]?.versions, [{ version_id: version, percentage: 100 }]);
      const ingress = await api("GET", path + "/subdomain");
      assert.equal(ingress.enabled, false);
      assert.equal(ingress.previews_enabled, false);
    } catch {
      failures.push(name);
    }
  }
  assert.equal(failures.length, 0, "paid_qa_parking_failed");
  return { parked: true, workers: 5, productionCertified: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snapshot = JSON.parse(readFileSync(PARKING_RECEIPT, "utf8"));
  console.log(
    JSON.stringify(await restorePaidQa(snapshot, createPaidQaControlPlane(process.env).api)),
  );
}
