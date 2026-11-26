import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PRIMARY_D1,
  REAL_CATALOG_MINIMUM_PRODUCTS,
  requireIsolatedCatalogSnapshotTarget,
  requireNoPrimaryD1PreviewBinding,
  requireMinimumRealCatalogSnapshot,
} from "./real-catalog-snapshot-safety.mjs";

const SNAPSHOT_ID = "a2a20f00-1111-4222-8333-444444444444";
const SNAPSHOT_NAME = "cove-isolated-legal-catalog-snapshot";
const validTarget = () => requireIsolatedCatalogSnapshotTarget(SNAPSHOT_ID, SNAPSHOT_NAME);
const validConfig = () => ({
  name: "cove-strangler-real-preview-12345-1",
  d1_databases: [{ binding: "DB", database_id: SNAPSHOT_ID, database_name: SNAPSHOT_NAME }],
  services: [],
  workers_dev: true,
  preview_urls: false,
  observability: { enabled: false },
  vars: {
    COVE_STRANGLER_DATABASE_ID: SNAPSHOT_ID,
    COVE_STRANGLER_MODE: "isolated-real-catalog",
    COVE_SSR_STAGING: "1",
    FORE_PUBLIC_URL: "https://cove-strangler-real-preview-12345-1.cove-jibrilmohamud.workers.dev",
  },
});
const goodResponse = () => [
  {
    results: [
      {
        products: REAL_CATALOG_MINIMUM_PRODUCTS,
        editions: REAL_CATALOG_MINIMUM_PRODUCTS,
        taxonomy_links: 1,
        rights_grants: 82_000,
      },
    ],
    meta: { changed_db: false, changes: 0, rows_written: 0 },
  },
];

test("production and existing incomplete 50k fixtures can NEVER back a Worker preview", () => {
  assert.deepEqual(validTarget(), { id: SNAPSHOT_ID, name: SNAPSHOT_NAME });
  for (const id of [
    undefined,
    "",
    PRIMARY_D1,
    PRIMARY_D1.toUpperCase(),
    "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    "E4CBB0EF-6288-4FA1-9DBB-FB42FE01D4F3",
    "cc842ee5-c526-431e-96ee-5e093fb45e6d",
    "arbitrary-db",
    "00000000-0000-0000-0000-000000000000;DELETE",
  ]) {
    assert.throws(() => requireIsolatedCatalogSnapshotTarget(id, SNAPSHOT_NAME));
  }
  for (const name of ["", "cove-production", "cove-primary", "unsafe", "cove-qa!"]) {
    assert.throws(() => requireIsolatedCatalogSnapshotTarget(SNAPSHOT_ID, name));
  }
});

test("deny multiple bindings, customer routes and production IDs even outside DB binding", () => {
  assert.equal(requireNoPrimaryD1PreviewBinding(validConfig(), SNAPSHOT_ID), true);
  for (const mutate of [
    (c) => {
      c.d1_databases[0].database_id = PRIMARY_D1;
    },
    (c) => {
      c.d1_databases.push({ binding: "PRIMARY_DB", database_id: PRIMARY_D1 });
    },
    (c) => {
      c.vars.SOURCE_PRIMARY = PRIMARY_D1;
    },
    (c) => {
      c.vars.SOURCE_PRIMARY = PRIMARY_D1.toUpperCase();
    },
    (c) => {
      c.d1_databases[0].database_id = PRIMARY_D1.toUpperCase();
    },
    (c) => {
      c.routes = ["covereads.com/*"];
    },
    (c) => {
      c.queues = { producers: ["production-jobs"] };
    },
    (c) => {
      c.d1_databases = [];
    },
  ]) {
    const config = validConfig();
    mutate(config);
    assert.throws(() => requireNoPrimaryD1PreviewBinding(config, SNAPSHOT_ID));
  }
});

test("a preview has no service, owner-DO, credential or customer-origin indirection", () => {
  const isolatedV2 = validConfig();
  isolatedV2.r2_buckets = [
    { binding: "PRESENTATION", bucket_name: "cove-strangler-private-presentation-stage" },
  ];
  isolatedV2.kv_namespaces = [
    { binding: "PRESENTATION_KV", id: "8245d5f2116a445d9571405b41b7c8c3" },
  ];
  assert.equal(requireNoPrimaryD1PreviewBinding(isolatedV2, SNAPSHOT_ID), true);
  const mutations = [
    (c) => {
      c.services = [{ binding: "OWNER", service: "cove-legal-authority-production" }];
    },
    (c) => {
      c.durable_objects = {
        bindings: [{ name: "LEGAL_AUTHORITY", class_name: "CoveLegalAuthority" }],
      };
    },
    (c) => {
      c.dispatch_namespaces = [{ binding: "DISPATCH", namespace: "cove-production" }];
    },
    (c) => {
      c.hyperdrive = [{ binding: "PRIMARY", id: "some-connection" }];
    },
    (c) => {
      c.workflows = [{ binding: "WRITER", name: "production" }];
    },
    (c) => {
      c.tail_consumers = [{ service: "cove-production-logs" }];
    },
    (c) => {
      c.unsafe = { bindings: [{ name: "PRIMARY_DB" }] };
    },
    (c) => {
      c.triggers = { crons: ["* * * * *"] };
    },
    (c) => {
      c.zone_id = "production-zone";
    },
    (c) => {
      c.workers_dev = false;
    },
    (c) => {
      c.preview_urls = true;
    },
    (c) => {
      c.name = "cove-persistence-backend";
    },
    (c) => {
      c.name = "cove-strangler-real-preview-12345-0";
    },
    (c) => {
      c.vars.FORE_PUBLIC_URL = "https://covereads.com";
    },
    (c) => {
      c.vars.COVE_STRANGLER_DATABASE_ID = PRIMARY_D1;
    },
    (c) => {
      c.vars.COVE_RIGHTS_OWNER_ENABLED = "1";
    },
    (c) => {
      c.vars.COVE_STRANGLER_MODE = "production-acceptance";
    },
    (c) => {
      c.vars.COVE_STRANGLER_RELEASE_CERTIFIED = "1";
    },
    (c) => {
      c.vars.COVE_SSR_STAGING = "0";
    },
    (c) => {
      c.vars.STRIPE_SECRET_KEY = "injected";
    },
    (c) => {
      c.observability.enabled = true;
    },
    (c) => {
      c.r2_buckets = [{ binding: "R2", bucket_name: "cove-production-media" }];
    },
    (c) => {
      c.kv_namespaces = [{ binding: "KV", id: "production" }];
    },
  ];
  for (const mutate of mutations) {
    const config = validConfig();
    mutate(config);
    assert.throws(() => requireNoPrimaryD1PreviewBinding(config, SNAPSHOT_ID));
  }
});

test("minimum snapshot metadata cannot certify incomplete, synthetic or mutated data", () => {
  const result = requireMinimumRealCatalogSnapshot(goodResponse());
  assert.equal(result.products, REAL_CATALOG_MINIMUM_PRODUCTS);
  assert.equal(result.legalGenerationAttested, false);
  assert.equal(result.releaseCertified, false);
  const mutations = [
    (x) => {
      x[0].results[0].products = 50_000;
    },
    (x) => {
      x[0].results[0].editions = 50_000;
    },
    (x) => {
      x[0].results[0].taxonomy_links = 0;
    },
    (x) => {
      x[0].results[0].rights_grants = 0;
    },
    (x) => {
      x[0].results[0].products = "82247";
    },
    (x) => {
      x[0].meta.changes = 1;
    },
    (x) => {
      x[0].meta.changed_db = true;
    },
    (x) => {
      x[0].meta.rows_written = 1;
    },
    (x) => {
      delete x[0].meta.changed_db;
    },
    (x) => {
      x.push(x[0]);
    },
    (x) => {
      x[0].results.push(x[0].results[0]);
    },
  ];
  for (const modify of mutations) {
    const x = goodResponse();
    modify(x);
    assert.throws(() => requireMinimumRealCatalogSnapshot(x));
  }
  assert.throws(() => requireMinimumRealCatalogSnapshot([]));
});

test("protected source never hardcodes primary D1 and checks snapshot before deployment", () => {
  const script = readFileSync("scripts/performance/strangler-real-catalog-acceptance.mjs", "utf8");
  const workflow = readFileSync(
    ".github/workflows/fast-storefront-real-catalog-acceptance.yml",
    "utf8",
  );
  assert.ok(!script.includes(PRIMARY_D1), "Production D1 ID must not appear in preview source");
  assert.match(script, /config\.vars\.COVE_STRANGLER_MODE = "isolated-real-catalog"/);
  assert.match(script, /assert\.equal\(dbId, reviewedSnapshotId,/);
  const runtime = readFileSync("src/storefront-strangler/worker.ts", "utf8");
  assert.match(runtime, /env\.COVE_STRANGLER_MODE === "isolated-real-catalog"/);
  assert.match(
    runtime,
    /env\.COVE_STRANGLER_DATABASE_ID === "15ce2ea3-17f8-4d99-9015-a78a6a3af05d"/,
  );
  assert.match(script, /requireIsolatedCatalogSnapshotTarget\(/);
  assert.match(script, /requireNoPrimaryD1PreviewBinding\(config, dbId\)/);
  assert.match(script, /requireMinimumRealCatalogSnapshot\(fixture\)/);
  assert.ok(script.includes("config.observability = { enabled: false }"));
  assert.ok(
    script.indexOf("requireMinimumRealCatalogSnapshot(fixture)") <
      script.indexOf("await deployFresh(i + 1)"),
    "Unverified fixtures must fail before any Worker creation",
  );
  assert.match(workflow, /COVE_REAL_CATALOG_SNAPSHOT_D1_ID:/);
  assert.match(workflow, /COVE_REAL_CATALOG_SNAPSHOT_D1_NAME:/);
  assert.match(workflow, /real-catalog-snapshot-safety\.test\.mjs/);
  assert.ok(!workflow.includes(PRIMARY_D1), "No primary D1 UUID in protected workflow");
  assert.match(workflow, /offline-isolation:/);
  assert.match(workflow, /Require isolated nonproduction D1 snapshot before any remote operations/);
});
