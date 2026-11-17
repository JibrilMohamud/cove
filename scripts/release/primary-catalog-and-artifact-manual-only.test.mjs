import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflows = [
  {
    path: ".github/workflows/publish-cloudflare-worker.yml",
    flag: "confirm_artifact_publish",
    job: "  publish:",
  },
  {
    path: ".github/workflows/fast-storefront-real-catalog-acceptance.yml",
    flag: "confirm_real_catalog_readonly",
    job: "  protected-real-catalog-acceptance:",
  },
  {
    path: ".github/workflows/cove-sounds-private-rollout.yml",
    flag: "confirm_private_sounds",
    job: "  private-sounds-release:",
  },
];

for (const { path, flag, job } of workflows) {
  const source = readFileSync(path, "utf8");
  const events = source.slice(
    source.indexOf("\non:\n") + 1,
    source.indexOf("\npermissions:\n"),
  );
  const protectedJob = source.slice(source.indexOf("\n" + job) + 1);

  test(path + " refuses all nonmanual branch pushes and scheduled releases", () => {
    assert.match(events, /\n  workflow_dispatch:\n/);
    assert.doesNotMatch(events, /\n  push:\n|\n  schedule:\n/);
    assert.match(events, /reviewed_main_sha:\n\s+description:/);
    assert.match(events, /required: true\n\s+type: string/);
    assert.ok(events.includes(flag + ":"));
    assert.match(events, /required: true\n\s+type: boolean\n\s+default: false/);
  });

  test(path + " requires approved exact main SHA and protected environment", () => {
    assert.ok(protectedJob.includes("environment: cove-production-release-audit"));
    assert.ok(protectedJob.includes("github.repository == 'JibrilMohamud/cove'"));
    assert.ok(protectedJob.includes("github.event_name == 'workflow_dispatch'"));
    assert.ok(protectedJob.includes("github.ref == 'refs/heads/main'"));
    assert.ok(protectedJob.includes("inputs." + flag + " == true"));
    assert.ok(protectedJob.includes("inputs.reviewed_main_sha == github.sha"));
    assert.ok(protectedJob.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'));
    assert.ok(protectedJob.includes('test "$DISPATCH_SHA" = "$EXPECTED_SHA"'));
    assert.doesNotMatch(protectedJob, /github\.event_name == 'push'/);
  });
}

test("artifact pipeline only publishes the reviewed Worker bundle to its artifact branch", () => {
  const source = readFileSync(".github/workflows/publish-cloudflare-worker.yml", "utf8");
  assert.match(source, /contents: write/);
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /git push origin HEAD:cloudflare-worker-artifact --force/);
  assert.doesNotMatch(source, /wrangler deploy|CLOUDFLARE_API_TOKEN/);
});

test("private Sounds production-worker secret rotation cannot follow a push or workflow completion", () => {
  const source = readFileSync(".github/workflows/cove-sounds-private-rollout.yml", "utf8");
  const events = source.slice(
    source.indexOf("\non:\n") + 1,
    source.indexOf("\npermissions:\n"),
  );
  assert.doesNotMatch(events, /\n  push:\n|\n  workflow_run:\n|\n  schedule:\n/);
  assert.match(source, /COVE_SOUNDS_SNAPSHOT_ENABLED/);
  assert.match(source, /environment: cove-production-release-audit/);
  assert.match(source, /inputs\.confirm_private_sounds == true/);
  assert.match(source, /inputs\.reviewed_main_sha == github\.sha/);
});
