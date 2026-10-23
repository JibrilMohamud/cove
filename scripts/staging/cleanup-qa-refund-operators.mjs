// A second, independent cleanup barrier: even if the browser Node process is
// killed, no QA finance grants survive. Applies ONLY to the disposable QA D1.
import { qaD1 } from "./qa-refund-operator.mjs";

const actor = "cove-isolated-qa-harness";
const role = "role_cove_synthetic_qa_refunds";
await qaD1(
  "DELETE FROM staff_principal_roles WHERE role_id=? AND user_id IN (SELECT user_id FROM staff_principals WHERE created_by_user_id=?)",
  [role, actor],
);
await qaD1(
  "UPDATE staff_principals SET status='disabled',updated_at=? WHERE created_by_user_id=?",
  [new Date().toISOString(), actor],
);
console.log("PASS: no isolated QA operator can retain commerce refund privilege after acceptance.");
