import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync("scripts/staging/roll-literary-isolated-utc-budget.mjs", "utf8");
const workflow = readFileSync(".github/workflows/literary-isolated-utc-budget.yml", "utf8");
for (const gate of [
  "literary_processing_owner",
  "literary_budget_domain",
  "previous[0]?.status !== \"active\"",
  "identity",
  "status='prepared'",
  "status='active'",
  "original_reserved_units",
  "original_calls",
]) assert.ok(worker.includes(gate), "Missing isolated UTC gate: " + gate);
assert.ok(worker.includes("day +"));
assert.ok(!worker.includes("SELECT * FROM rights_grants"));
assert.ok(workflow.includes('cron: "25 0 * * *"'));
assert.ok(workflow.includes("cancel-in-progress: false"));
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
assert.ok(workflow.includes("persist-credentials: false"));
assert.ok(workflow.includes("needs: static"));
console.log("LITERARY_UTC_BUDGET_ROLLOVER_POLICY_PASS previous active day required");
