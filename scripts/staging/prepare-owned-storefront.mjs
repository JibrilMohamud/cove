import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { requireIsolatedCatalogSnapshotTarget } from "../performance/real-catalog-snapshot-safety.mjs";
import { seedReadOnlyPresentation } from "./seed-versioned-presentation.mjs";

const id = "15ce2ea3-17f8-4d99-9015-a78a6a3af05d";
const databaseName = "cove-real-catalog-snapshot-20261125";
requireIsolatedCatalogSnapshotTarget(
  process.env.COVE_REAL_CATALOG_SNAPSHOT_D1_ID,
  process.env.COVE_REAL_CATALOG_SNAPSHOT_D1_NAME,
);
assert.equal(process.env.COVE_REAL_CATALOG_SNAPSHOT_D1_ID, id);
assert.equal(process.env.COVE_REAL_CATALOG_SNAPSHOT_D1_NAME, databaseName);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
assert.match(process.env.GITHUB_RUN_ID || "", /^[1-9][0-9]+$/);
const gate = randomBytes(32).toString("hex");
const authority = randomBytes(32).toString("hex");
console.log("::add-mask::" + gate);
console.log("::add-mask::" + authority);
const write = (file, body) => fs.writeFileSync(file, body, { mode: 0o600 });
write(".owned-gate-secrets.json", JSON.stringify({ COVE_SSR_STAGING_GATE_KEY: gate }));
write(".owned-authority-secrets.json", JSON.stringify({ COVE_HOMEPAGE_AUTHORITY_KEY: authority }));
write(
  ".owned-homepage-secrets.json",
  JSON.stringify({ COVE_SSR_STAGING_GATE_KEY: gate, COVE_HOMEPAGE_AUTHORITY_KEY: authority }),
);
fs.appendFileSync(
  process.env.GITHUB_ENV,
  `COVE_GATE_TEST_BEARER=${gate}\nCOVE_SSR_STAGING_GATE_KEY=${gate}\nCOVE_OWNED_ROLLBACK_GATE_KEY=${gate}\n`,
);
const base = {
  compatibility_date: "2026-10-19",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  preview_urls: false,
  observability: { enabled: false },
};
const vars = {
  COVE_SSR_STAGING: "1",
  COVE_STRANGLER_MODE: "isolated-real-catalog",
  COVE_STRANGLER_DATABASE_ID: id,
  COVE_STRANGLER_READ_MODEL: "2",
  COVE_STRANGLER_RELEASE_CERTIFIED: "0",
  FORE_ENVIRONMENT: "production",
  FORE_DEFAULT_TERRITORY: "US",
  FORE_PUBLIC_URL: "https://ssr-canary.covereads.com",
};
const isolatedD1 = [{ binding: "DB", database_id: id, database_name: databaseName }];
const authorityConfig = {
  ...base,
  name: "cove-owned-homepage-authority",
  main: ".output/strangler/isolated-homepage-authority.mjs",
  d1_databases: isolatedD1,
  vars,
};
const prefix = `campaign/${process.env.GITHUB_RUN_ID}/real/`;
const homepage = {
  ...base,
  name: "cove-owned-homepage-stage",
  main: ".output/strangler/index.mjs",
  vars: {
    ...vars,
    COVE_STRANGLER_EXPERIENCE: "1",
    COVE_SSR_DIAGNOSTICS: "1",
    COVE_PRESENTATION_PREFIX: prefix,
    COVE_PRESENTATION_KV_ACCELERATE: "1",
  },
  services: [{ binding: "COVE_ISOLATED_HOMEPAGE_AUTHORITY", service: authorityConfig.name }],
  r2_buckets: [
    { binding: "PRESENTATION", bucket_name: "cove-strangler-private-presentation-stage" },
  ],
  kv_namespaces: [{ binding: "PRESENTATION_KV", id: "8245d5f2116a445d9571405b41b7c8c3" }],
  ratelimits: [
    {
      name: "COVE_STOREFRONT_READ_LIMITER",
      namespace_id: String(800000 + (Number(process.env.GITHUB_RUN_ID) % 100000)),
      simple: { limit: 10000, period: 60 },
    },
  ],
};
// Native snapshot reads for full-application GET delegation; never production
// REST or production media. The wrapper makes every D1 statement read-only.
write(
  ".output/server/owned-isolated-entry.mjs",
  `import app from "./index.mjs";\nimport { readOnlyStageD1 } from "../strangler/readonly-stage-d1.mjs";\nexport default {fetch(request,env,ctx){if(env.COVE_STRANGLER_DATABASE_ID!=="${id}"||env.COVE_SSR_STAGING!=="1")return new Response(null,{status:503});return app.fetch(request,{...env,DB:readOnlyStageD1(env.DB)},ctx)}};\n`,
);
const application = {
  ...base,
  name: "cove-asset-auth-stage",
  main: ".output/server/owned-isolated-entry.mjs",
  assets: { directory: ".output/public", binding: "ASSETS", run_worker_first: true },
  d1_databases: isolatedD1,
  // Full application APIs use their canonical read adapter. Only the
  // separate homepage renderer has the prepared presentation bindings.
  vars: { ...vars, COVE_STRANGLER_READ_MODEL: "0" },
  ratelimits: homepage.ratelimits,
};
const gateway = {
  ...base,
  name: "cove-asset-auth-gateway",
  main: "src/cloudflare/staging-auth-gateway.mjs",
  workers_dev: true,
  services: [
    { binding: "STAGING", service: application.name },
    { binding: "HOMEPAGE", service: homepage.name },
  ],
  vars: {
    COVE_STAGING_INGRESS_HOST: "cove-asset-auth-gateway.cove-jibrilmohamud.workers.dev",
    COVE_STAGING_CANARY_HOST: "ssr-canary.covereads.com",
    COVE_OWNED_ISOLATED_SNAPSHOT: id,
  },
};
for (const [file, config] of [
  ["authority", authorityConfig],
  ["homepage", homepage],
  ["application", application],
  ["gateway", gateway],
]) {
  const serialized = JSON.stringify(config, null, 2);
  assert.ok(!serialized.includes("4bd657ac-8789-403e-a28c-93aba8d0a989"));
  assert.ok(!serialized.includes("cove-canonical-d1-readonly"));
  assert.ok(!serialized.includes("cove-production-media"));
  assert.ok(!config.routes && !config.triggers && !config.queues);
  write(`wrangler.owned-${file}.run.json`, serialized);
}
await seedReadOnlyPresentation({
  assertContractlessView: true,
  readToken: process.env.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN,
  source: id,
  sourceName: databaseName,
  prefix,
  directory: "artifacts/owned-storefront",
  kvNamespaceId: "8245d5f2116a445d9571405b41b7c8c3",
});
console.log(
  "Prepared owned ingress: isolated canonical read port, prepared homepage, private full application and authenticated assets",
);
