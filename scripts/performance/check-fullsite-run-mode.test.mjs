import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { shouldRunProductionProbe } from "../production-storefront-run-mode.mjs";

const workflow = readFileSync(".github/workflows/fullsite-performance.yml", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
const browser = readFileSync("scripts/performance/fullsite-browser.mjs", "utf8");

test("disabled main auto-deployment must not wait for a nonexistent production SHA", () => {
  assert.equal(vercel.git.deploymentEnabled.main, false);
  assert.equal(shouldRunProductionProbe("push", vercel), false);
  assert.equal(shouldRunProductionProbe("workflow_dispatch", vercel), true);
  assert.equal(shouldRunProductionProbe("push", { git: { deploymentEnabled: {} } }), true);
});

test("fullsite push still executes offline acceptance assertions but skips live unpromoted commit", () => {
  assert.match(workflow, /name: fullsite-performance/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /jobs:\s*preflight:/);
  assert.match(workflow, /steps\.mode\.outputs\.should_probe/);
  assert.match(workflow, /node scripts\/production-storefront-run-mode\.mjs/);
  assert.match(workflow, /needs\.preflight\.outputs\.should_probe == 'true'/);
  assert.match(workflow, /github\.event_name != 'pull_request'/);
});

test("approved live run retains exact-SHA Vercel, Worker, and rights-backed catalog guards", () => {
  const probe = workflow.split("  public-browser-baseline:\n")[1];
  assert.ok(probe, "Required real browser job missing");
  assert.match(probe, /node scripts\/wait-vercel-production\.mjs/);
  assert.match(probe, /node scripts\/wait-persistence-backend-production\.mjs/);
  assert.match(probe, /node scripts\/wait-live-storefront-catalog\.mjs/);
  assert.match(probe, /node scripts\/performance\/route-inventory\.mjs/);
  assert.match(probe, /node scripts\/performance\/fullsite-browser\.mjs/);
  assert.match(probe, /if: github\.event_name == 'push'/);
  assert.match(
    browser,
    /if \(results\.some\(\(r\) => r\.failure \|\| r\.pageErrors\.length\)\) process\.exitCode = 1/,
  );
});

test("no change to strict capacity threshold checks or synthetic browser failure behavior", () => {
  const capacity = readFileSync("scripts/performance/check-owned-ssr-capacity.test.mjs", "utf8");
  assert.match(workflow, /node --test scripts\/performance\/check-owned-ssr-capacity\.test\.mjs/);
  assert.match(workflow, /node scripts\/check-secondary-home-discovery-admission\.mjs/);
  assert.match(workflow, /npx playwright install --with-deps chromium/);
  assert.match(capacity, /800/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});
