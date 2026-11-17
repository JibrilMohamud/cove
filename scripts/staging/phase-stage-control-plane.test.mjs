import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertExactTokenPolicy,
  assertPinnedDeployment,
  assertIsolatedStageBindings,
  assertParkedStage,
  PARKED_READER_VERSION,
  PARKED_SSR_VERSION,
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
      {
        name: "COVE_CANONICAL_READONLY",
        type: "service",
        service: "cove-canonical-phase-readonly-staging",
      },
    ],
  };
  assert.doesNotThrow(() => assertIsolatedStageBindings(reader, ssr));
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
