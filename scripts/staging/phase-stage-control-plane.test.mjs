import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertExactTokenPolicy,
  assertPinnedDeployment,
  assertIsolatedStageBindings,
  assertParkedStage,
  PARKED_READER_VERSION,
  PARKED_SSR_VERSION,
  parkedPostflightRetryReason,
  verifyParkedPostflight,
} from "./phase-stage-control-plane.mjs";

const account = "com.cloudflare.api.account.d26430caa63ec55f6612e32f36aca5e9";
const d1Group = "192192df92ee43ac90f2aeeffce67e35";
const writeGroup = "e086da7e2179491d91ee5f35b3ca210a";
const version = "401f2af2-6e69-4611-8110-1d127af6eecf";
const policy = (group) => ({
  status: "active",
  policies: [
    {
      effect: "allow",
      permission_groups: [{ id: group }],
      resources: { [account]: "*" },
    },
  ],
});

test("separately scoped D1 Read and Workers Scripts Write tokens only", () => {
  assert.doesNotThrow(() => assertExactTokenPolicy(policy(d1Group), d1Group));
  assert.doesNotThrow(() => assertExactTokenPolicy(policy(writeGroup), writeGroup));
  const broad = policy(d1Group);
  broad.policies[0].permission_groups.push({ id: writeGroup });
  assert.throws(() => assertExactTokenPolicy(broad, d1Group));
  assert.throws(() => assertExactTokenPolicy(policy(writeGroup), d1Group));
  const inactive = policy(d1Group);
  inactive.status = "disabled";
  assert.throws(() => assertExactTokenPolicy(inactive, d1Group));
  const extra = policy(d1Group);
  extra.policies.push({ effect: "allow", permission_groups: [], resources: {} });
  assert.throws(() => assertExactTokenPolicy(extra, d1Group));
});

test("production pin requires exactly one immutable version at 100 percent", () => {
  const pinned = { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] };
  assert.doesNotThrow(() => assertPinnedDeployment(pinned, version));
  assert.throws(() => assertPinnedDeployment({}, version));
  assert.throws(() =>
    assertPinnedDeployment(
      {
        deployments: [
          {
            versions: [
              { version_id: version, percentage: 99 },
              { version_id: "other", percentage: 1 },
            ],
          },
        ],
      },
      version,
    ),
  );
});

test("only private staging read service with no native D1 and gated SSR is allowed", () => {
  const reader = {
    bindings: [
      { name: "COVE_STAGE_READ_PHASE_DIAGNOSTICS", type: "plain_text", text: "1" },
      { name: "D1_READ_API_TOKEN", type: "secret_text" },
    ],
  };
  const ssr = {
    bindings: [
      { name: "COVE_SSR_STAGING", type: "plain_text", text: "1" },
      { name: "COVE_SSR_STAGING_GATE_KEY", type: "secret_text" },
      { name: "COVE_CANONICAL_READONLY_FETCH", type: "plain_text", text: "1" },
      {
        name: "COVE_CANONICAL_READONLY",
        type: "service",
        service: "cove-canonical-phase-readonly-staging",
      },
    ],
  };
  assert.doesNotThrow(() => assertIsolatedStageBindings(reader, ssr));
  assert.throws(() =>
    assertIsolatedStageBindings(reader, {
      bindings: ssr.bindings.filter((binding) => binding.name !== "COVE_CANONICAL_READONLY_FETCH"),
    }),
  );
  assert.throws(() =>
    assertIsolatedStageBindings(reader, {
      bindings: [
        ...ssr.bindings,
        { name: "COVE_CANONICAL_READONLY_RPC", type: "plain_text", text: "1" },
      ],
    }),
  );
  assert.throws(() =>
    assertIsolatedStageBindings(reader, {
      bindings: ssr.bindings.map((binding) =>
        binding.name === "COVE_CANONICAL_READONLY_FETCH" ? { ...binding, text: "0" } : binding,
      ),
    }),
  );
  assert.throws(() =>
    assertIsolatedStageBindings(
      { bindings: [...reader.bindings, { name: "DB", type: "d1" }] },
      ssr,
    ),
  );
  assert.throws(() =>
    assertIsolatedStageBindings(reader, {
      bindings: ssr.bindings.map((x) =>
        x.name === "COVE_CANONICAL_READONLY" ? { ...x, service: "cove-canonical-d1-readonly" } : x,
      ),
    }),
  );
  assert.throws(() =>
    assertIsolatedStageBindings(reader, {
      bindings: [...ssr.bindings, { name: "BUCKET", type: "r2_bucket" }],
    }),
  );
  assert.throws(() =>
    assertIsolatedStageBindings(reader, {
      bindings: [...ssr.bindings, { name: "COVE_SSR_STAGING_COMMERCE_QA", text: "1" }],
    }),
  );
  // A restricted read-only test may not gain another service, arbitrary
  // secret, KV namespace, queue, Durable Object or other unseen capability.
  for (const forbidden of [
    { name: "PRODUCTION_PERSISTENCE", type: "service", service: "cove-persistence-backend" },
    { name: "WRITABLE_CACHE", type: "kv_namespace" },
    { name: "PUBLISH_QUEUE", type: "queue" },
    { name: "LEGAL_OWNER", type: "durable_object_namespace" },
    { name: "UNREVIEWED_SECRET", type: "secret_text" },
    { name: "UNKNOWN_SETTING", type: "plain_text", text: "1" },
    { name: "ASSETS", type: "r2_bucket" },
  ]) {
    assert.throws(() =>
      assertIsolatedStageBindings(reader, { bindings: [...ssr.bindings, forbidden] }),
    );
  }
  assert.throws(() =>
    assertIsolatedStageBindings(reader, { bindings: [...ssr.bindings, ssr.bindings[0]] }),
  );
});

test("one-time seeded deny-only Workers must be exactly parked before and after every run", () => {
  const parked = {
    reader: { resources: { bindings: [] } },
    ssr: { resources: { bindings: [] } },
    readerDeployment: {
      deployments: [{ versions: [{ version_id: PARKED_READER_VERSION, percentage: 100 }] }],
    },
    ssrDeployment: {
      deployments: [{ versions: [{ version_id: PARKED_SSR_VERSION, percentage: 100 }] }],
    },
    readerSubdomain: { enabled: false, previews_enabled: false },
    ssrSubdomain: { enabled: false, previews_enabled: false },
    domains: [],
  };
  assert.doesNotThrow(() => assertParkedStage(parked));
  for (const change of [
    { reader: { resources: { bindings: [{ name: "D1_READ_API_TOKEN", type: "secret_text" }] } } },
    {
      ssr: {
        resources: { bindings: [{ name: "COVE_SSR_STAGING_GATE_KEY", type: "secret_text" }] },
      },
    },
    { readerSubdomain: { enabled: true, previews_enabled: false } },
    { ssrSubdomain: { enabled: true, previews_enabled: false } },
    { ssrSubdomain: { enabled: false, previews_enabled: true } },
    { ssrDeployment: { deployments: [{ versions: [{ version_id: "other", percentage: 100 }] }] } },
    {
      readerDeployment: {
        deployments: [{ versions: [{ version_id: PARKED_READER_VERSION, percentage: 99 }] }],
      },
    },
    { domains: [{ service: "cove-storefront-phase-staging" }] },
    { domains: [{ service: "cove-canonical-phase-readonly-staging" }] },
    { domains: null },
  ])
    assert.throws(() => assertParkedStage({ ...parked, ...change }));
});

test("immutable version evidence uses existing Workers Scripts Write, not metadata-only token", () => {
  const stage = readFileSync("scripts/staging/phase-stage-control-plane.mjs", "utf8");
  const workflow = readFileSync(
    ".github/workflows/cove-protected-canonical-phase-staging.yml",
    "utf8",
  );
  assert.match(stage, /index < 2 \? deploy : metadata/);
  assert.match(stage, /get\(index < 2 \? deploy : metadata, path\)/);
  assert.match(stage, /stageParked\(metadata, process\.env\.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN\)/);
  assert.match(
    workflow,
    /name: ALWAYS verify production pins, disabled owner and parked stage isolation/,
  );
  const postflight = workflow.slice(
    workflow.indexOf(
      "name: ALWAYS verify production pins, disabled owner and parked stage isolation",
    ),
  );
  assert.match(
    postflight,
    /COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN: \$\{\{ secrets\.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN \}\}/,
  );
  assert.match(
    postflight,
    /COVE_CF_WORKERS_METADATA_READ_TOKEN: \$\{\{ secrets\.COVE_CF_WORKERS_METADATA_READ_TOKEN \}\}/,
  );
});

test("Smart Placement experiment exists ONLY on isolated read-only phase staging", () => {
  const candidate = JSON.parse(readFileSync("wrangler.canonical-phase.staging.jsonc", "utf8"));
  const production = JSON.parse(
    readFileSync("wrangler.canonical-readonly.jsonc", "utf8").replace(/,\s*}/g, "}"),
  );
  const owner = JSON.parse(
    readFileSync("wrangler.legal-authority.production-locked.jsonc", "utf8"),
  );
  assert.equal(candidate.name, "cove-canonical-phase-readonly-staging");
  assert.equal(candidate.main, "infra/canonical-readonly/worker.ts");
  assert.deepEqual(candidate.placement, { mode: "smart" });
  assert.equal(candidate.workers_dev, false);
  assert.equal(candidate.preview_urls, false);
  assert.deepEqual(candidate.routes, []);
  assert.equal(candidate.d1_databases, undefined);
  assert.equal(candidate.services, undefined);
  const stage = readFileSync("wrangler.frontend.phase.staging.toml", "utf8");
  assert.match(stage, /COVE_CANONICAL_READONLY_FETCH = "1"/);
  assert.doesNotMatch(stage, /COVE_CANONICAL_READONLY_RPC = "1"/);
  assert.match(
    readFileSync("infra/canonical-readonly/worker.ts", "utf8"),
    /async fetch\(request: Request\)/,
  );
  assert.equal(production.placement, undefined);
  assert.equal(owner.placement, undefined);
  assert.equal(production.name, "cove-canonical-d1-readonly");
  assert.equal(owner.name, "cove-legal-authority-production");
});

test("bounded parked postflight waits for Cloudflare deploy and ingress convergence", async () => {
  assert.equal(
    parkedPostflightRetryReason(new Error("Existing Worker version/traffic pin changed")),
    "parked_version_pending",
  );
  assert.equal(
    parkedPostflightRetryReason(
      new Error("cove-storefront-phase-staging must have no public HTTP ingress"),
    ),
    "stage_ingress_disable_pending",
  );
  assert.equal(
    parkedPostflightRetryReason(
      new Error("cove-canonical-phase-readonly-staging previews must be disabled"),
    ),
    "stage_preview_disable_pending",
  );
  const results = [
    "Existing Worker version/traffic pin changed",
    "cove-storefront-phase-staging previews must be disabled",
  ];
  let calls = 0;
  let sleeps = 0;
  const originalLog = console.log;
  console.log = () => {}; // Prevent test-only pending markers from polluting CI.
  try {
    const attempts = await verifyParkedPostflight(
      async () => {
        calls++;
        const next = results.shift();
        if (next) throw new Error(next);
      },
      async (ms) => {
        assert.equal(ms, 2_000);
        sleeps++;
      },
      4,
    );
    assert.equal(attempts, 3);
    assert.equal(calls, 3);
    assert.equal(sleeps, 2);
  } finally {
    console.log = originalLog;
  }
});

test("postflight never accepts a persistent delayed version or public ingress", async () => {
  for (const code of [
    "Existing Worker version/traffic pin changed",
    "cove-canonical-phase-readonly-staging must have no public HTTP ingress",
  ]) {
    let checks = 0;
    let sleeps = 0;
    const originalLog = console.log;
    console.log = () => {};
    try {
      await assert.rejects(
        verifyParkedPostflight(
          async () => {
            checks++;
            throw new Error(code);
          },
          async () => {
            sleeps++;
          },
          3,
        ),
        /Protected staging postflight never converged/,
      );
    } finally {
      console.log = originalLog;
    }
    assert.equal(checks, 3);
    assert.equal(sleeps, 2);
  }
});

test("postflight does not retry unknown bindings, domains, permissions or owner changes", async () => {
  const unsafe = [
    "cove-storefront-phase-staging parked bindings must be empty",
    "Stage Workers must have no customer custom domains",
    "Protected read-only Cloudflare API preflight failed",
    "Production legal owner changed",
    "Unknown stage SSR binding name or capability type",
  ];
  for (const message of unsafe) {
    assert.equal(parkedPostflightRetryReason(new Error(message)), null);
    let checks = 0;
    await assert.rejects(
      verifyParkedPostflight(
        async () => {
          checks++;
          throw new Error(message);
        },
        async () => {
          throw new Error("Must not sleep after unsafe change");
        },
        3,
      ),
      { message },
    );
    assert.equal(checks, 1);
  }
  await assert.rejects(
    verifyParkedPostflight(
      async () => {},
      async () => {},
      13,
    ),
  );
});

test("production pin check occurs outside the stage-only postflight convergence loop", () => {
  const source = readFileSync("scripts/staging/phase-stage-control-plane.mjs", "utf8");
  assert.match(
    source,
    /await pinnedProduction\(metadata\);[\s\S]*?await verifyParkedPostflight\(\(\) =>\s*stageParked\(metadata, process\.env\.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN\)/,
  );
});
