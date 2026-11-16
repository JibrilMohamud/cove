import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { shouldRunProductionProbe } from "./production-storefront-run-mode.mjs";

test("main push with disabled Git production builds must not wait on a nonexistent deployment", () => {
  assert.equal(
    shouldRunProductionProbe("push", { git: { deploymentEnabled: { main: false } } }),
    false,
  );
  assert.equal(shouldRunProductionProbe("push", { git: { deploymentEnabled: false } }), false);
});
test("real automatic production push candidates retain the fail-closed deployment wait", () => {
  assert.equal(
    shouldRunProductionProbe("push", { git: { deploymentEnabled: { main: true } } }),
    true,
  );
  assert.equal(shouldRunProductionProbe("push", { git: { deploymentEnabled: {} } }), true);
  assert.equal(shouldRunProductionProbe("push", {}), true);
});
test("manual and scheduled runs may measure the pinned public storefront", () => {
  for (const event of ["workflow_dispatch", "schedule", "pull_request"]) {
    assert.equal(
      shouldRunProductionProbe(event, { git: { deploymentEnabled: { main: false } } }),
      true,
    );
  }
});
test("the real release-safety source prevents an audit-only main push from being certified", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.equal(config.git?.deploymentEnabled?.main, false);
  assert.equal(shouldRunProductionProbe("push", config), false);
});
