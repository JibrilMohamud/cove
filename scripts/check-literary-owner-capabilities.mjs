import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "cove-literary-port-"));
try {
  await build({
    stdin: {
      contents:
        'export * from "./src/storefront-strangler/literary-owner-protocol"; export * from "./src/storefront-strangler/literary-owner-service";',
      resolveDir: process.cwd(),
    },
    outfile: path.join(dir, "port.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const {
    handleLiteraryOwnerService,
    scopeLiteraryPrimaryReadEnv,
    literaryReads,
    LITERARY_READ_ROUTE,
    LITERARY_HANDOFF_ROUTE,
    LITERARY_PUBLICATION_ROUTE,
  } = await import(path.join(dir, "port.mjs"));
  let reads = 0,
    calls = 0;
  const secret = "a".repeat(64),
    handoffSecret = "b".repeat(64),
    publicationSecret = "c".repeat(64);
  const primary = {
    prepare(sql) {
      reads++;
      assert.ok(Object.values(literaryReads).some((r) => r.sql === sql));
      return {
        bind() {
          return this;
        },
        async first() {
          return { value: "isolated" };
        },
      };
    },
  };
  const env = {
    PRIMARY_DB: primary,
    LITERARY_CONTENT_DB: {},
    LITERARY_BUCKET: {},
    COVE_RIGHTS_OWNER_PRIMARY_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989",
    COVE_LITERARY_READ_SECRET: secret,
    COVE_LITERARY_HANDOFF_SECRET: handoffSecret,
    COVE_LITERARY_PUBLICATION_SECRET: publicationSecret,
  };
  const request = (route, body, key = secret, method = "POST") =>
    new Request("https://owner.internal" + route, {
      method,
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
  for (const [req, override, status] of [
    [request(LITERARY_READ_ROUTE, { op: "processingOwner", args: [] }, "d".repeat(64)), {}, 401],
    [
      request(LITERARY_READ_ROUTE, { op: "processingOwner", args: [] }),
      { COVE_RIGHTS_OWNER_PRIMARY_ID: "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e" },
      503,
    ],
    [request(LITERARY_READ_ROUTE, { op: "processingOwner", args: [] }, secret, "GET"), {}, 405],
    [
      request(LITERARY_READ_ROUTE, {
        op: "processingOwner",
        args: [],
        sql: "UPDATE rights_grants SET status='active'",
      }),
      {},
      400,
    ],
    [request(LITERARY_READ_ROUTE, { op: "__proto__", args: [] }), {}, 400],
    [
      request(LITERARY_READ_ROUTE, { op: "profileReceipt", args: ["p';DELETE FROM products"] }),
      {},
      400,
    ],
    [request(LITERARY_READ_ROUTE, { op: "profileReceipt", args: [] }), {}, 400],
    [request(LITERARY_HANDOFF_ROUTE, {}, secret), {}, 401],
    [request(LITERARY_HANDOFF_ROUTE, { flags: "enable" }, handoffSecret), {}, 400],
    [request(LITERARY_PUBLICATION_ROUTE, { jobId: "0".repeat(64) }, secret), {}, 401],
    [
      request(
        LITERARY_PUBLICATION_ROUTE,
        { jobId: "0".repeat(64), profile: {} },
        publicationSecret,
      ),
      {},
      400,
    ],
  ]) {
    const before = reads;
    assert.equal((await handleLiteraryOwnerService(req, { ...env, ...override })).status, status);
    assert.equal(reads, before, "Rejected capability must not reach any database");
  }
  const deferredBefore = reads;
  const deferred = await handleLiteraryOwnerService(
    request(LITERARY_HANDOFF_ROUTE, { reconcile: true }, handoffSecret),
    env,
  );
  assert.equal(deferred.status, 200, "Admission deferral remains a successful no-work cron result");
  assert.equal((await deferred.json()).skipped, "primary_unavailable");
  assert.equal(reads, deferredBefore + 1, "Unavailable primary must prevent all job effects");
  const port = {
    async fetch(req) {
      calls++;
      return handleLiteraryOwnerService(req, env);
    },
  };
  const scoped = scopeLiteraryPrimaryReadEnv({
    COVE_LITERARY_PRIVATE_READ_ENABLED: "1",
    COVE_LITERARY_READ_SECRET: secret,
    LITERARY_PRIMARY_READER: port,
  });
  assert.deepEqual(await scoped.DB.prepare(literaryReads.processingOwner.sql).first(), {
    value: "isolated",
  });
  const before = calls;
  for (const sql of [
    "SELECT * FROM users",
    "UPDATE rights_grants SET status='active'",
    "SELECT 1 AS ok; DELETE FROM products",
    "WITH x AS (SELECT 1) DELETE FROM products",
  ])
    assert.throws(() => scoped.DB.prepare(sql), /not_allowed/);
  await assert.rejects(scoped.DB.prepare(literaryReads.admission.sql).run(), /write_forbidden/);
  await assert.rejects(scoped.DB.batch([]), /batch_forbidden/);
  assert.equal(calls, before);
  assert.throws(
    () => scopeLiteraryPrimaryReadEnv({ ...scoped, DB: primary }),
    /capability_invalid/,
  );
  const unavailable = scopeLiteraryPrimaryReadEnv({
    COVE_LITERARY_PRIVATE_READ_ENABLED: "1",
    COVE_LITERARY_READ_SECRET: secret,
    LITERARY_PRIMARY_READER: {
      async fetch() {
        return new Response(null, { status: 503 });
      },
    },
  });
  await assert.rejects(
    unavailable.DB.prepare(literaryReads.processingOwner.sql).first(),
    /unavailable_503/,
  );
  for (const file of [
    "wrangler.content-literary-handoff.prod-draining.jsonc",
    "wrangler.content-literary-prepare.prod-draining.jsonc",
    "wrangler.content-literary-infer.prod-isolated.jsonc",
    "wrangler.content-literary-infer.prod-disabled.jsonc",
    "wrangler.literary-publisher.prod-isolated.jsonc",
    "wrangler.literary-publisher.prod-disabled.jsonc",
  ]) {
    const config = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.ok(!config.routes && !config.route);
    assert.ok(
      !config.d1_databases.some((b) => b.database_id === "4bd657ac-8789-403e-a28c-93aba8d0a989"),
    );
    assert.ok(config.services.some((b) => b.service === "cove-legal-authority-production"));
    if (file.includes("handoff") || file.includes("publisher")) {
      assert.deepEqual(config.d1_databases, []);
      assert.deepEqual(config.r2_buckets, []);
    }
  }
  console.log(
    "PASS: fixed literary owner reads, no SQL/customer input, separated mutation secrets, denial before D1, no raw/batch/write/outage fallback and no canonical D1 in active/dormant configs",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
