import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflows = [
  [".github/workflows/cloudflare-native-ssr-staging.yml", "deploy-staging:"],
  [".github/workflows/covereads-secure-ssr-gateway.yml", "isolated-asset-auth:"],
];

for (const [path, jobName] of workflows) {
  const source = readFileSync(path, "utf8");
  const trigger = source.slice(source.indexOf("\non:\n") + 1, source.indexOf("\npermissions:\n"));
  const privileged = source.slice(source.indexOf("\n  " + jobName) + 1);

  test(path + " cannot dispatch staging from source pushes or scheduled cron", () => {
    assert.match(trigger, /^on:\n  pull_request:/);
    assert.match(trigger, /\n  workflow_dispatch:\n/);
    assert.doesNotMatch(trigger, /\n  push:\n|\n  schedule:\n/);
  });

  test(path + " requires protected approved main SHA and explicit operator consent", () => {
    assert.ok(privileged.includes("environment: cove-production-release-audit"));
    assert.ok(privileged.includes("github.repository == 'JibrilMohamud/cove'"));
    assert.ok(privileged.includes("github.event_name == 'workflow_dispatch'"));
    assert.ok(privileged.includes("github.ref == 'refs/heads/main'"));
    assert.ok(privileged.includes("inputs.confirm_isolated_stage_only == true"));
    assert.ok(privileged.includes("inputs.reviewed_main_sha == github.sha"));
    assert.ok(privileged.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'));
    assert.ok(privileged.includes('test "$DISPATCH_SHA" = "$EXPECTED_SHA"'));
    assert.ok(privileged.includes("group: cove-exclusive-real-primary-cold-acceptance"));
    assert.ok(privileged.includes("cancel-in-progress: false"));
    assert.ok(privileged.includes("persist-credentials: false"));
    assert.ok(privileged.includes("CLOUDFLARE_API_TOKEN"));
  });

  test(path + " manual inputs must fail closed", () => {
    assert.match(
      trigger,
      /reviewed_main_sha:\n\s+description:[^\n]+\n\s+required: true\n\s+type: string/,
    );
    assert.match(
      trigger,
      /confirm_isolated_stage_only:\n\s+description:[^\n]+\n\s+required: true\n\s+type: boolean\n\s+default: false/,
    );
  });
}
