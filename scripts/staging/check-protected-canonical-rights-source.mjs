import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const audit = readFileSync(
  "scripts/staging/check-protected-canonical-real-d1-differential.mjs",
  "utf8",
);
const workflow = readFileSync(
  ".github/workflows/cove-protected-stage-canonical-rights-differential.yml",
  "utf8",
);

assert.match(audit, /COVE_CF_STAGE_D1_READ_TOKEN/);
assert.doesNotMatch(audit, /process\.env\.CLOUDFLARE_API_TOKEN/);
assert.doesNotMatch(audit, /4bd657ac-8789-403e-a28c-93aba8d0a989/);
assert.match(audit, /e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3/);
assert.match(audit, /COVE_SYNTHETIC_OWNER_DIFF_ONLY/);
assert.match(audit, /MAX_READ_QUERIES = 1400/);
assert.match(audit, /READ_PACE_MS = 75/);
assert.match(audit, /Write-capable or multi-statement SQL is forbidden/);
assert.match(audit, /assertSyntheticRightsDifferentialCoverage\(output\)/);
assert.match(audit, /if \(!advancedPolicyStrataCovered\)/);
assert.match(audit, /fullProductionRightsParityCertified: false/);
assert.doesNotMatch(audit, /\.run\(\)|\.exec\(/);
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
assert.match(workflow, /inputs\.reviewed_main_sha == github\.sha/);
assert.match(workflow, /inputs\.confirm == 'STAGE_RIGHTS_DIFF'/);
assert.match(workflow, /environment: cove-production-release-audit/);
assert.match(workflow, /secrets\.COVE_CF_STAGE_D1_READ_TOKEN/);
assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
assert.doesNotMatch(workflow, /workflow_call:/);
const offline = workflow.split("  protected-stage-only:")[0];
assert.doesNotMatch(offline, /secrets\\.|COVE_CF_STAGE_D1_READ_TOKEN/);
console.log(
  "PASS: exact isolated D1 identity, hard read budget, protected main SHA, " +
    "independent scoped D1 Read credential and mandatory legal-policy cohorts",
);
