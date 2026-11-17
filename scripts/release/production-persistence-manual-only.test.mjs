import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/deploy-persistence-backend.yml", "utf8");
const eventHeader = workflow.slice(
  workflow.indexOf("\non:\n") + 1,
  workflow.indexOf("\npermissions:\n"),
);

test("production Worker deployment cannot be triggered by any main push", () => {
  assert.match(eventHeader, /^on:\n  #/);
  assert.match(eventHeader, /\n  workflow_dispatch:\n/);
  assert.doesNotMatch(eventHeader, /\n  push:\s*\n|\n  pull_request:\s*\n/);
  assert.doesNotMatch(workflow, /COVE_PRODUCTION_PERSISTENCE_AUTO_DEPLOY/);
});

test("protected deployment requires reviewer, exact main commit and explicit approval", () => {
  assert.match(workflow, /environment: cove-production-release-audit/);
  assert.match(workflow, /group: cove-exclusive-real-primary-cold-acceptance/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(
    workflow,
    /reviewed_main_sha:\n\s+description:[^\n]*\n\s+required: true\n\s+type: string/,
  );
  assert.match(
    workflow,
    /confirm_production_deploy:\n\s+description:[^\n]*\n\s+required: true\n\s+default: false\n\s+type: boolean/,
  );
  assert.match(workflow, /github\.repository == 'JibrilMohamud\/cove'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /inputs\.confirm_production_deploy == true/);
  assert.match(workflow, /inputs\.reviewed_main_sha == github\.sha/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow, /persist-credentials: false/);
});

test("production migrations and their Cloudflare credentials remain protected", () => {
  assert.match(workflow, /apply_migrations:[\s\S]*?default: false/);
  assert.match(workflow, /inputs\.apply_migrations == true/);
  assert.match(workflow, /steps\.deploy_auth\.outputs\.enabled == 'true'/);
  assert.match(workflow, /cove-persistence-backend/);
  assert.match(workflow, /cove-production-media/);
});
