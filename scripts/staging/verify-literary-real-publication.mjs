import assert from "node:assert/strict";
import { artifact, isolated, owner, primary, query } from "./literary-isolated-operator-lib.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const initial = await query(isolated, "SELECT COUNT(*) n FROM literary_legacy_reconcile_receipts");
const minimumReceipts = Number(initial[0]?.n || 0);
let certified = null;
for (let round = 0; round < 75; round++) {
  assert.deepEqual(await owner(), {
    literary_budget_domain: "isolated",
    literary_processing_owner: "isolated",
  });
  const [inferred, frontier, receipts] = await Promise.all([
    query(
      isolated,
      "SELECT product_id,profile_fingerprint,profile_revision,publication_state" +
        " FROM literary_inference_jobs WHERE status='done'" +
        " AND publication_state IN ('published','held') LIMIT 8",
    ),
    query(isolated, "SELECT status FROM literary_legacy_reconcile_frontier WHERE id=1"),
    query(isolated, "SELECT COUNT(*) n FROM literary_legacy_reconcile_receipts"),
  ]);
  assert.ok(["armed", "complete"].includes(frontier[0]?.status));
  assert.ok(Number(receipts[0]?.n) >= minimumReceipts, "Replay frontier regressed");
  const published = inferred.filter((j) => j.publication_state === "published");
  if (published.length > 0) {
    for (const job of published) {
      assert.match(job.product_id, /^[a-zA-Z0-9_-]{1,120}$/);
      assert.match(job.profile_fingerprint, /^[a-zA-Z0-9_-]{1,180}$/);
      const canonical = await query(
        primary,
        "SELECT fingerprint,revision,status,coverage FROM literary_profiles" +
          " WHERE product_id='" +
          job.product_id +
          "'",
      );
      assert.deepEqual(canonical, [
        {
          fingerprint: job.profile_fingerprint,
          revision: job.profile_revision + 1,
          status: "analyzed",
          coverage: "isolated_samples",
        },
      ]);
    }
    certified = {
      schema: "cove.literary.real-publication.v1",
      at: new Date().toISOString(),
      verifiedCanonicalProfiles: published.length,
      replayReceiptsAtStart: minimumReceipts,
      replayReceiptsAfter: receipts[0].n,
      owner: "isolated",
      budgetDomain: "isolated",
      privateServiceBinding: true,
      correctRevisionAndFingerprint: true,
    };
    break;
  }
  await wait(15000);
}
assert.ok(certified, "No canonical publication verified in bounded propagation window");
artifact("real-isolated-publication.json", certified);
console.log("LITERARY_REAL_PRODUCTION_PUBLICATION_PASS", JSON.stringify(certified));
