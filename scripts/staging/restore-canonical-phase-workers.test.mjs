import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ownedStageParkPlan,
  restoreOwnedStageWorkers,
} from "./restore-canonical-phase-workers.mjs";
import { PARKED_READER_VERSION, PARKED_SSR_VERSION } from "./phase-stage-control-plane.mjs";

const token = "a".repeat(40);
const approved = {
  COVE_PHASE_STAGE_PREFLIGHT_PASSED: "1",
  COVE_PHASE_READER_CREATE_ATTEMPTED: "1",
  COVE_PHASE_SSR_CREATE_ATTEMPTED: "1",
  COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN: token,
};
const prefix =
  "https://api.cloudflare.com/client/v4/accounts/" +
  "d26430caa63ec55f6612e32f36aca5e9/workers/scripts/";

test("restore only two fixed parked versions, consumer first, never production", () => {
  assert.deepEqual(ownedStageParkPlan(approved), [
    { name: "cove-storefront-phase-staging", version: PARKED_SSR_VERSION },
    { name: "cove-canonical-phase-readonly-staging", version: PARKED_READER_VERSION },
  ]);
  assert.deepEqual(ownedStageParkPlan({ ...approved, COVE_PHASE_SSR_CREATE_ATTEMPTED: "0" }), [
    { name: "cove-canonical-phase-readonly-staging", version: PARKED_READER_VERSION },
  ]);
});

test("restore 100% immutable deny-only version and disable public/preview ingress", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  assert.deepEqual(await restoreOwnedStageWorkers(approved, request), { parked: 2 });
  assert.deepEqual(
    calls.map((x) => x.url),
    [
      prefix + "cove-storefront-phase-staging/deployments",
      prefix + "cove-storefront-phase-staging/subdomain",
      prefix + "cove-canonical-phase-readonly-staging/deployments",
      prefix + "cove-canonical-phase-readonly-staging/subdomain",
    ],
  );
  for (let i = 0; i < calls.length; i++) {
    const { url, options } = calls[i];
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer " + token);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.ok(!url.includes("?"));
    assert.ok(!url.includes("/storage/kv/"));
    const body = JSON.parse(options.body);
    if (i % 2 === 0) {
      assert.deepEqual(body, {
        strategy: "percentage",
        versions: [
          {
            version_id: i === 0 ? PARKED_SSR_VERSION : PARKED_READER_VERSION,
            percentage: 100,
          },
        ],
      });
    } else {
      assert.deepEqual(body, { enabled: false, previews_enabled: false });
    }
  }
});

test("partial update rolls back only attempted names; preflight denial never mutates", async () => {
  const request = async () => {
    throw Error("unexpected control-plane mutation");
  };
  assert.deepEqual(
    ownedStageParkPlan({
      ...approved,
      COVE_PHASE_READER_CREATE_ATTEMPTED: "0",
      COVE_PHASE_SSR_CREATE_ATTEMPTED: "0",
    }),
    [],
  );
  assert.deepEqual(
    await restoreOwnedStageWorkers(
      {
        ...approved,
        COVE_PHASE_READER_CREATE_ATTEMPTED: "0",
        COVE_PHASE_SSR_CREATE_ATTEMPTED: "0",
      },
      request,
    ),
    { parked: 0 },
  );
  await assert.rejects(
    () =>
      restoreOwnedStageWorkers({ ...approved, COVE_PHASE_STAGE_PREFLIGHT_PASSED: "0" }, request),
    /Parked-stage preflight required/,
  );
  await assert.rejects(
    () =>
      restoreOwnedStageWorkers(
        { ...approved, COVE_PHASE_READER_CREATE_ATTEMPTED: "true" },
        request,
      ),
    /Invalid stage deployment marker/,
  );
});

test("restoration fails closed on provider denial or error envelope", async () => {
  await assert.rejects(
    () => restoreOwnedStageWorkers({ ...approved, COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN: "" }),
    /Scoped stage Editor token absent/,
  );
  for (const reply of [
    { ok: false, status: 403 },
    { ok: true, status: 200, json: async () => ({ success: false }) },
  ]) {
    await assert.rejects(
      () => restoreOwnedStageWorkers(approved, async () => reply),
      /Stage parked/,
    );
  }
});

test("workflow updates existing named Workers; safe restore before independent postflight", () => {
  const src = readFileSync(".github/workflows/cove-protected-canonical-phase-staging.yml", "utf8");
  const p = src.indexOf("node scripts/staging/phase-stage-control-plane.mjs preflight");
  const a = src.indexOf('echo "COVE_PHASE_READER_CREATE_ATTEMPTED=1"');
  const b = src.indexOf("wrangler deploy --config wrangler.canonical-phase.staging.jsonc");
  const c = src.indexOf('echo "COVE_PHASE_SSR_CREATE_ATTEMPTED=1"');
  const d = src.indexOf("wrangler deploy --config wrangler.frontend.phase.staging.toml");
  const e = src.indexOf("run: node scripts/staging/restore-canonical-phase-workers.mjs");
  const f = src.indexOf("run: node scripts/staging/phase-stage-control-plane.mjs postflight");
  assert.ok(p > 0 && p < a && a < b && b < c && c < d && d < e && e < f);
  assert.match(src, /if: always\(\) && env.COVE_PHASE_STAGE_PREFLIGHT_PASSED == '1'/);
  assert.match(src, /COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN:/);
  assert.doesNotMatch(src, /wrangler delete|delete-canonical-phase-workers\.mjs/);
  assert.doesNotMatch(
    src,
    /--force --config|CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN/,
  );
  assert.match(src, /COVE_PHASE_SSR_DEPLOYED == '1'/);
});
