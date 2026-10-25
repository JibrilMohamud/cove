import assert from "node:assert/strict";
import {
  content,
  evidenceFile,
  owner,
  pause,
  primary,
  query,
} from "./literary-drain-operator-lib.mjs";

// Cron propagation may take up to 15 minutes. Require evidence of actual
// primary outbox delivery AND independent evidence preparation, not merely
// that an owner flag changed.
let success = null;
for (let attempt = 0; attempt < 75; attempt++) {
  assert.deepEqual(await owner(), { literary: "draining", budget: "isolated" });
  const [frontier, receipts, outbox, prepared, failed] = await Promise.all([
    query(content, "SELECT status,after_job_id FROM literary_legacy_reconcile_frontier WHERE id=1"),
    query(content, "SELECT COUNT(*) n FROM literary_legacy_reconcile_receipts"),
    query(primary, "SELECT COUNT(*) n FROM literary_prepare_outbox WHERE status='delivered'"),
    query(content, "SELECT COUNT(*) n FROM literary_prepare_jobs WHERE status='done'"),
    query(content, "SELECT COUNT(*) n FROM literary_prepare_jobs WHERE status='failed'"),
  ]);
  assert.ok(["armed", "complete"].includes(frontier[0]?.status));
  // Individual malformed/withdrawn sources stay held; do not roll the whole
  // storefront back because one book is unprocessable. Abort only when there
  // is a repeated failure pattern and zero successfully prepared evidence.
  if (failed[0].n >= 6 && prepared[0].n === 0)
    throw Error("Repeated isolated EPUB failures without any valid preparation");
  if (receipts[0].n > 0 && outbox[0].n > 0 && prepared[0].n > 0) {
    success = {
      observedAt: new Date().toISOString(),
      frontier: frontier[0],
      reconciled: receipts[0].n,
      delivered: outbox[0].n,
      prepared: prepared[0].n,
      quarantined: failed[0].n,
      primaryCustomerPublicationStillFenced: true,
      performancePolicy: "100ms guarded D1 admission; at most eight reconciliations/minute",
    };
    break;
  }
  await pause(15000);
}
assert.ok(success, "Active draining Workers failed to produce durable EPUB evidence");
evidenceFile("draining-first-real-work.json", success);
console.log("LITERARY_DRAIN_FIRST_REAL_WORK_PASS", JSON.stringify(success));
