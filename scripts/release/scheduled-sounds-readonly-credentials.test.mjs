import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(
  ".github/workflows/cove-sounds-verified-conversion-report.yml",
  "utf8",
);
const paid = readFileSync("scripts/staging/report-cove-sounds-verified-conversion.mjs", "utf8");
const inventory = readFileSync("scripts/staging/report-cove-sounds-market-readiness.mjs", "utf8");

test("scheduled report keeps static verification and uses protected main-only credentials", () => {
  assert.match(workflow, /schedule:\s*\n\s*- cron:/);
  assert.match(workflow, /environment: cove-production-release-audit/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /confirm_readonly_reporting == true/);
  assert.match(workflow, /inputs\.reviewed_main_sha == github\.sha/);
  assert.match(workflow, /github\.event_name == 'schedule'/);
  assert.match(
    workflow,
    /node --test scripts\/release\/scheduled-sounds-readonly-credentials\.test\.mjs/,
  );
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /secrets\.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN/);
  assert.match(workflow, /secrets\.COVE_CF_ANALYTICS_READ_TOKEN/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
});

test("both reporting scripts reject the generic broad deploy token", () => {
  for (const source of [paid, inventory]) {
    assert.doesNotMatch(source, /process\.env\.CLOUDFLARE_API_TOKEN/);
    assert.match(source, /COVE_CF_PRODUCTION_AUDIT_READ_TOKEN/);
    assert.doesNotMatch(source, /\bUPDATE\s+commerce_orders\b/i);
  }
  assert.match(paid, /COVE_CF_ANALYTICS_READ_TOKEN/);
  assert.match(paid, /scopedReportingToken\(path, contentType\)/);
  assert.match(paid, /assert\.equal\(method, "POST"/);
  assert.match(inventory, /requireScopedD1ReadToken\(\)/);
});

test("reporters independently exercise their scoped-credential and response contracts offline", () => {
  for (const path of [
    "scripts/staging/report-cove-sounds-verified-conversion.mjs",
    "scripts/staging/report-cove-sounds-market-readiness.mjs",
  ]) {
    const p = spawnSync(process.execPath, [path, "--self-test"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "" },
    });
    assert.equal(p.status, 0, path + ": " + (p.stderr || p.stdout));
    assert.match(p.stdout, /PASS:/);
  }
});
