import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const requirePattern = (source, pattern) => assert.ok(pattern.test(source), "Required stage audit guard missing");
const forbidPattern = (source, pattern) => assert.ok(!pattern.test(source), "Forbidden stage audit authority detected");

const audit = readFileSync(
  "scripts/staging/check-protected-canonical-real-d1-differential.mjs",
  "utf8",
);
const workflow = readFileSync(
  ".github/workflows/cove-protected-stage-canonical-rights-differential.yml",
  "utf8",
);

requirePattern(audit, /COVE_CF_STAGE_D1_READ_TOKEN/);
forbidPattern(audit, /process\.env\.CLOUDFLARE_API_TOKEN/);
forbidPattern(audit, /4bd657ac-8789-403e-a28c-93aba8d0a989/);
requirePattern(audit, /e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3/);
requirePattern(audit, /COVE_SYNTHETIC_OWNER_DIFF_ONLY/);
requirePattern(audit, /MAX_READ_QUERIES = 1400/);
requirePattern(audit, /READ_PACE_MS = 75/);
requirePattern(audit, /Write-capable or multi-statement SQL is forbidden/);
requirePattern(audit, /assertSyntheticRightsDifferentialCoverage\(output\)/);
requirePattern(audit, /if \(!advancedPolicyStrataCovered\)/);
requirePattern(audit, /fullProductionRightsParityCertified:\\s*false/);
forbidPattern(audit, /\.run\(\)|\.exec\(/);
requirePattern(workflow, /workflow_dispatch:/);
requirePattern(workflow, /github\.ref == 'refs\/heads\/main'/);
requirePattern(workflow, /inputs\.reviewed_main_sha == github\.sha/);
requirePattern(workflow, /inputs\.confirm == 'STAGE_RIGHTS_DIFF'/);
requirePattern(workflow, /environment: cove-production-release-audit/);
requirePattern(workflow, /secrets\.COVE_CF_STAGE_D1_READ_TOKEN/);
forbidPattern(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
forbidPattern(workflow, /workflow_call:/);
const offline = workflow.split("  protected-stage-only:")[0];
forbidPattern(offline, /secrets\.|COVE_CF_STAGE_D1_READ_TOKEN/);
console.log(
  "PASS: exact isolated D1 identity, hard read budget, protected main SHA, " +
    "independent scoped D1 Read credential and mandatory legal-policy cohorts",
);
