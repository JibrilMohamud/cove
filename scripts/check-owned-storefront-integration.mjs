import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { localBindings } from "./local-api.mjs";
import gateway from "../src/cloudflare/staging-auth-gateway.mjs";
import { createIsolatedPresentationReader } from "./staging/isolated-presentation-read.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-owned-storefront-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: {
      worker: "src/storefront-strangler/worker.ts",
      authority: "src/storefront-strangler/isolated-homepage-authority.ts",
      presentation: "src/storefront-strangler/homepage-presentation.server.ts",
      api: "src/features/fore/api.server.ts",
      readonly: "src/storefront-strangler/readonly-stage-d1.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    logLevel: "silent",
  });
  const [
    { default: worker },
    { default: authority },
    { produceHomepagePresentation },
    { handleCoveApi },
    { readOnlyStageD1 },
  ] = await Promise.all(
    ["worker", "authority", "presentation", "api", "readonly"].map(
      (name) => import(path.join(root, name + ".js")),
    ),
  );
  const native = localBindings(root);
  const seed = await handleCoveApi(new Request("https://local/api/fore/storefront/bootstrap"), {
    ...native,
    FORE_ENVIRONMENT: "development",
  });
  assert.equal(seed.status, 200);
  const objects = new Map();
  const store = {
    async put(k, body) {
      objects.set(k, body);
    },
    async get(k) {
      const body = objects.get(k);
      return body ? { size: Buffer.byteLength(body), text: async () => body } : null;
    },
  };
  let preparationReads = 0;
  const preparation = createIsolatedPresentationReader({
    readToken: "offline-fixture-token-000000000000",
    source: "15ce2ea3-17f8-4d99-9015-a78a6a3af05d",
    sourceName: "cove-real-catalog-snapshot-20261125",
    fetchImpl: async (_url, init) => {
      preparationReads++;
      const { sql, params } = JSON.parse(init.body);
      const rows = await native.DB.prepare(sql)
        .bind(...params)
        .all();
      return Response.json({
        success: true,
        result: [
          { ...rows, success: true, meta: { changed_db: false, changes: 0, rows_written: 0 } },
        ],
      });
    },
  });
  await produceHomepagePresentation(preparation, "US", store);
  assert.ok(
    preparationReads > 4,
    "Presentation seed must exercise real metadata projections through the read-only HTTP adapter",
  );
  const gate = "a".repeat(64),
    privateKey = "b".repeat(64);
  const scope = {
    COVE_SSR_STAGING: "1",
    COVE_STRANGLER_MODE: "isolated-real-catalog",
    COVE_STRANGLER_DATABASE_ID: "15ce2ea3-17f8-4d99-9015-a78a6a3af05d",
    COVE_STRANGLER_READ_MODEL: "2",
    COVE_HOMEPAGE_AUTHORITY_KEY: privateKey,
  };
  let reads = 0,
    sessions = 0;
  const primary = {
    prepare(sql) {
      reads++;
      assert.match(sql.trim(), /^(SELECT|WITH)\s/);
      return native.DB.prepare(sql);
    },
    withSession(constraint) {
      assert.equal(constraint, "first-primary");
      sessions++;
      return primary;
    },
  };
  const authorityEnv = { ...scope, DB: primary };
  const homepageEnv = {
    ...scope,
    COVE_SSR_STAGING_GATE_KEY: gate,
    COVE_STRANGLER_EXPERIENCE: "1",
    PRESENTATION: store,
    COVE_STOREFRONT_READ_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    COVE_ISOLATED_HOMEPAGE_AUTHORITY: { fetch: (req) => authority.fetch(req, authorityEnv) },
  };
  assert.equal(homepageEnv.DB, undefined, "Homepage renderer has no database binding");
  let applicationRequests = 0;
  const env = {
    COVE_STAGING_INGRESS_HOST: "owned.test",
    COVE_SSR_STAGING_GATE_KEY: gate,
    COVE_OWNED_ISOLATED_SNAPSHOT: scope.COVE_STRANGLER_DATABASE_ID,
    HOMEPAGE: { fetch: (req) => worker.fetch(req, homepageEnv) },
    STAGING: {
      async fetch(req) {
        applicationRequests++;
        return new Response(new URL(req.url).pathname, {
          headers: { "content-type": "text/plain" },
        });
      },
    },
  };
  const req = (route = "/", headers = {}, method = "GET") => {
    const request = new Request("https://owned.test" + route, {
      method,
      headers: { authorization: "Bearer " + gate, "cf-connecting-ip": "203.0.113.1", ...headers },
    });
    Object.defineProperty(request, "cf", { value: { country: "US" } });
    return request;
  };
  const first = await gateway.fetch(req("/", { "x-cove-client-country": "ZZ" }), env);
  assert.equal(first.status, 200);
  const html = await first.text();
  assert.match(html, /data-rights-country="US"/);
  assert.match(html, /data-cove-client-ready|dataset.coveClientReady/);
  assert.match(first.headers.get("server-timing"), /cove_catalog;dur=/);
  assert.ok(reads >= 1 && sessions === 1);
  assert.equal(applicationRequests, 0);
  const product = /data-product="([^"]+)"/.exec(html)[1];
  // A completed display snapshot cannot resurrect a withdrawn canonical book.
  await native.DB.prepare("UPDATE products SET storefront_status='withdrawn' WHERE id=?")
    .bind(product)
    .run();
  const withdrawn = await gateway.fetch(req(), env);
  assert.equal(withdrawn.status, 200);
  assert.ok(!(await withdrawn.text()).includes(`data-product="${product}"`));
  assert.equal(sessions, 2, "Every response opens a fresh primary session");
  for (const route of [
    "/library",
    "/reader/123",
    "/api/fore/account",
    "/assets/application.js",
    "/covers/1.jpg",
    "/?storefront=full",
  ]) {
    const response = await gateway.fetch(req(route), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), new URL("https://owned.test" + route).pathname);
  }
  await gateway.fetch(req("/", { cookie: "session=opaque" }), env);
  assert.equal(applicationRequests, 7, "Account hints keep the full application adapter");
  assert.equal((await gateway.fetch(req("/", {}, "POST"), env)).status, 405);
  assert.equal(
    (await gateway.fetch(new Request("https://owned.test/covers/1.jpg"), env)).status,
    401,
  );
  assert.equal(
    (await gateway.fetch(req("/", { authorization: "Bearer " + "c".repeat(64) }), env)).status,
    401,
  );
  assert.equal(
    (
      await gateway.fetch(req(), {
        ...env,
        COVE_OWNED_ISOLATED_SNAPSHOT: "4bd657ac-8789-403e-a28c-93aba8d0a989",
      })
    ).status,
    503,
  );
  const failed = {
    ...homepageEnv,
    COVE_ISOLATED_HOMEPAGE_AUTHORITY: {
      async fetch() {
        throw Error("unavailable");
      },
    },
  };
  assert.equal((await worker.fetch(req(), failed)).status, 503);
  assert.equal(
    (
      await worker.fetch(req(), {
        ...homepageEnv,
        COVE_STRANGLER_DATABASE_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989",
      })
    ).status,
    503,
  );
  const authorize = (body, key = privateKey, overrides = {}) =>
    authority.fetch(
      new Request("https://legal-authority.internal/storefront/authorize-batch", {
        method: "POST",
        headers: { authorization: "Bearer " + key },
        body: JSON.stringify(body),
      }),
      { ...authorityEnv, ...overrides },
    );
  const valid = { ids: [product], territory: "US", currency: "USD" };
  for (const bad of [
    { ...valid, sql: "SELECT * FROM users" },
    { ...valid, ids: ["prd_gutenberg_1;DELETE"] },
    { ...valid, ids: Array(129).fill(product) },
    { ...valid, ids: [product, product] },
    { ...valid, territory: "US'" },
  ])
    assert.equal((await authorize(bad)).status, 400);
  assert.equal(
    (await authorize(valid, gate)).status,
    401,
    "Outer bearer cannot call private authority",
  );
  assert.equal(
    (
      await authorize(valid, privateKey, {
        COVE_STRANGLER_DATABASE_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989",
      })
    ).status,
    503,
  );
  assert.equal(
    (await authorize(valid, privateKey, { COVE_STRANGLER_RELEASE_CERTIFIED: "1" })).status,
    503,
  );
  const workflow = fs.readFileSync(".github/workflows/covereads-secure-ssr-gateway.yml", "utf8");
  assert.ok(!workflow.includes("cp wrangler.frontend.staging.toml"));
  assert.ok(workflow.includes("real-catalog-copy-receipt.mjs --verify"));
  // Exercise the actual generated deployment graph without provider I/O.
  // Only the presentation upload transport is stubbed; no token is supplied.
  const deployRoot = path.join(root, "deploy");
  fs.mkdirSync(path.join(deployRoot, ".output/server"), { recursive: true });
  await build({
    entryPoints: ["scripts/staging/prepare-owned-storefront.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "prepare.mjs"),
    logLevel: "silent",
    plugins: [
      {
        name: "offline-presentation-transport",
        setup(builder) {
          builder.onLoad({ filter: /seed-versioned-presentation\.mjs$/ }, () => ({
            contents: "export async function seedReadOnlyPresentation() {}",
            loader: "js",
          }));
        },
      },
    ],
  });
  const processEnv = {
    ...process.env,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "12345678901",
    GITHUB_ENV: path.join(root, "env"),
    COVE_REAL_CATALOG_SNAPSHOT_D1_ID: scope.COVE_STRANGLER_DATABASE_ID,
    COVE_REAL_CATALOG_SNAPSHOT_D1_NAME: "cove-real-catalog-snapshot-20261125",
  };
  const prepared = spawnSync(process.execPath, [path.join(root, "prepare.mjs")], {
    cwd: deployRoot,
    env: processEnv,
    encoding: "utf8",
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const configs = Object.fromEntries(
    ["authority", "homepage", "application", "gateway"].map((name) => [
      name,
      JSON.parse(fs.readFileSync(path.join(deployRoot, `wrangler.owned-${name}.run.json`), "utf8")),
    ]),
  );
  // Delegation must exercise the actual application with its generated vars,
  // not only prove that a fake CORE receives the correct URL.
  const readFence = readOnlyStageD1(native.DB);
  assert.equal(
    (await readFence.prepare("SELECT replace('a-b','-','_') AS value").first()).value,
    "a_b",
  );
  for (const sql of [
    "REPLACE INTO products(id) VALUES('forged')",
    "WITH candidates AS (SELECT 1) REPLACE INTO products(id) VALUES('forged')",
    "WITH candidates AS (SELECT 1) DELETE FROM products",
    "SELECT 1; DELETE FROM products",
    "SELECT load_extension('untrusted')",
    "SELECT 1 /* hidden operation */",
  ])
    assert.throws(() => readFence.prepare(sql));
  assert.throws(() => readFence.batch([native.DB.prepare("SELECT 1")]));
  const applicationEnv = {
    ...native,
    ...configs.application.vars,
    DB: readOnlyStageD1(native.DB),
    COVE_STOREFRONT_READ_LIMITER: homepageEnv.COVE_STOREFRONT_READ_LIMITER,
  };
  for (const route of ["/health/ready", "/storefront/bootstrap"]) {
    const result = await handleCoveApi(
      new Request("https://owned.test/api/fore" + route, {
        headers: { "x-cove-client-country": "US", "cf-connecting-ip": "203.0.113.1" },
      }),
      applicationEnv,
    );
    assert.equal(result.status, 200, "Delegated application route failed: " + route);
    const body = await result.json();
    if (route === "/storefront/bootstrap") assert.ok(body.catalog.results.length > 0);
    else assert.equal(body.database, true);
  }
  assert.equal(configs.homepage.d1_databases, undefined);
  assert.deepEqual(configs.homepage.services, [
    { binding: "COVE_ISOLATED_HOMEPAGE_AUTHORITY", service: configs.authority.name },
  ]);
  assert.equal(configs.gateway.assets, undefined);
  assert.equal(configs.gateway.d1_databases, undefined);
  assert.equal(configs.gateway.services.length, 2);
  for (const name of ["authority", "application"]) {
    assert.equal(configs[name].d1_databases[0].database_id, scope.COVE_STRANGLER_DATABASE_ID);
    assert.equal(configs[name].workers_dev, false);
    assert.equal(configs[name].services, undefined);
  }
  assert.ok(
    fs
      .readFileSync(path.join(deployRoot, ".output/server/owned-isolated-entry.mjs"), "utf8")
      .includes("readOnlyStageD1(env.DB)"),
  );
  const rejected = spawnSync(process.execPath, [path.join(root, "prepare.mjs")], {
    cwd: deployRoot,
    env: {
      ...processEnv,
      COVE_REAL_CATALOG_SNAPSHOT_D1_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989",
    },
    encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0, "Production substitution must fail before provider I/O");
  console.log(
    "PASS: full-schema owned ingress, D1-unbound prepared renderer, fresh primary rights, withdrawal, isolated authority, asset/session delegation and denial",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
