/** Contract tests for the leased schedule RPC. Business work is deliberately
 * stubbed here; actual seven-entrypoint coverage lives in the full-schema test. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const folder = mkdtempSync(join(tmpdir(), "cove-schedule-rpc-"));
const sqlite = new DatabaseSync(":memory:");
try {
  const output = join(folder, "rpc.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/qa-owner-scheduled-execution.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "fixed-business-work-fixture",
        setup(b) {
          b.onResolve({ filter: /persistence-backend\.worker$/ }, () => ({
            path: "job",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `export function scheduleBackendOwnedWork(c,e,ctx){
    globalThis.__coveJobCapture(e);ctx.waitUntil(globalThis.__coveJobTask(c,e));
   }`,
          }));
        },
      },
    ],
  });
  const {
    dispatchQaOwnerScheduledTick: dispatch,
    serveQaOwnerScheduledTick: serve,
    QA_SCHEDULE_ROUTE: route,
    QA_SCHEDULE_SCHEMA: schema,
    OWNER_SCHEDULES: crons,
  } = await import(pathToFileURL(output).href);
  const secret = "a".repeat(64),
    primary = "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
  const env = {
    COVE_QA_SCHEDULE_OWNER_ENABLED: "1",
    FORE_ENVIRONMENT: "staging",
    COVE_SSR_STAGING: "1",
    COVE_RIGHTS_OWNER_ENABLED: "1",
    COVE_RIGHTS_OWNER_PRIMARY_ID: primary,
    COVE_LEGAL_WRITER_PRIMARY_ID: primary,
    COVE_PUBLICATION_COMMAND_TERRITORY: "US",
    COVE_PUBLICATION_COMMAND_CURRENCY: "USD",
    COVE_RIGHTS_OWNER_SECRET: secret,
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 600000),
  };
  let writes = 0,
    invocations = 0,
    captured;
  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async run() {
          writes++;
          return { success: true };
        },
      };
    },
    async batch(items) {
      return Promise.all(items.map((x) => x.run()));
    },
  };
  const storage = {
    sql: {
      exec(query, ...args) {
        const statement = sqlite.prepare(query);
        const rows = statement.columns().length
          ? statement.all(...args)
          : (statement.run(...args), []);
        return { toArray: () => rows };
      },
    },
    transactionSync(fn) {
      sqlite.exec("BEGIN");
      try {
        const r = fn();
        sqlite.exec("COMMIT");
        return r;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const request = (body, options = {}) =>
    new Request("https://legal-authority.internal" + route, {
      method: "POST",
      headers: {
        authorization: "Bearer " + secret,
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(body),
      ...options,
    });
  const command = (cron = crons[0]) => ({ schema, cron, slot: Math.floor(Date.now() / 60000) });
  const ownerEnv = { ...env, PRIMARY_DB: db };
  const owner = { fetch: (r) => serve(r, ownerEnv, storage, owner) };
  const caller = {
    ...env,
    LEGAL_AUTHORITY: {
      getByName(name) {
        assert.equal(name, "cove-staged-legal-global-v1");
        return owner;
      },
    },
  };
  globalThis.__coveJobCapture = (e) => {
    captured = e;
    invocations++;
  };
  globalThis.__coveJobTask = async (c, e) =>
    e.DB.prepare("UPDATE catalog_state SET last_error='' WHERE id=1").run();
  const first = await dispatch({ cron: crons[0] }, caller);
  assert.equal(first.completed, true);
  assert.equal(writes, 1);
  assert.equal(invocations, 1);
  assert.equal("PRIMARY_DB" in captured, false, "Native handle must not leak around domain fences");
  await dispatch({ cron: crons[0] }, caller);
  assert.equal(writes, 1, "Complete replay must not repeat work");
  assert.equal(invocations, 1);
  for (const query of [
    "UPDATE products SET status='active'",
    "UPDATE entitlements SET status='active'",
    "INSERT INTO gutenberg_rights_evidence(id) VALUES('forged')",
    "DROP TABLE catalog_state",
  ]) {
    assert.throws(
      () => captured.DB.prepare(query),
      undefined,
      "Canonical and DDL mutations remain fenced",
    );
  }
  assert.equal(writes, 1);
  // A lost successful acknowledgement cannot re-execute the claimed tick.
  let lost = true;
  const lossy = {
    ...caller,
    LEGAL_AUTHORITY: {
      getByName() {
        return {
          async fetch(r) {
            const ack = await owner.fetch(r);
            if (lost) {
              lost = false;
              throw Error("fixture_lost_ack");
            }
            return ack;
          },
        };
      },
    },
  };
  await assert.rejects(() => dispatch({ cron: crons[1] }, lossy), /fixture_lost_ack/);
  const afterLost = writes;
  await dispatch({ cron: crons[1] }, lossy);
  assert.equal(writes, afterLost);
  // Overlapping invocation sees pending and never starts a second job.
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.__coveJobTask = () => blocked;
  const pending = owner.fetch(request(command(crons[2])));
  while (invocations < 3) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await owner.fetch(request(command(crons[2])))).status, 409);
  release();
  assert.equal((await pending).status, 200);
  // Resolved failure receipts and thrown tasks both poison this tick permanently.
  for (const [cron, task] of [
    [crons[3], async () => ({ ok: false })],
    [
      crons[4],
      async () => {
        throw Error("private-secret");
      },
    ],
  ]) {
    globalThis.__coveJobTask = task;
    const response = await owner.fetch(request(command(cron)));
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("private-secret"), false);
    const before = invocations;
    assert.equal((await owner.fetch(request(command(cron)))).status, 503);
    assert.equal(invocations, before);
  }
  const before = invocations;
  for (const body of [
    { ...command(), sql: "DELETE FROM products" },
    { ...command(), cron: "arbitrary-job" },
    { ...command(), slot: command().slot - 3 },
    { ...command(), slot: 1.2 },
    null,
  ])
    assert.equal((await owner.fetch(request(body))).status, 400);
  assert.equal(
    (
      await owner.fetch(
        request(command(), {
          headers: { authorization: "Bearer bad", "content-type": "application/json" },
        }),
      )
    ).status,
    401,
  );
  for (const overrides of [
    { FORE_ENVIRONMENT: "production" },
    { COVE_RIGHTS_OWNER_PRIMARY_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
    { COVE_RIGHTS_OWNER_PRIMARY_ID: "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3" },
    { COVE_LEGAL_WRITER_PRIMARY_ID: "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3" },
    {
      COVE_RIGHTS_OWNER_PRIMARY_ID: "3ffb3c0b-72b2-4a47-b63a-18aaf77762ea",
      COVE_LEGAL_WRITER_PRIMARY_ID: "3ffb3c0b-72b2-4a47-b63a-18aaf77762ea",
    },
    { COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: "0" },
    { COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 3600000) },
    { STRIPE_LIVEMODE: "true" },
    { STRIPE_SECRET_KEY: "sk_live_forbidden" },
    { COVE_OWNER_EXCLUSIVE_WRITER_FENCE: "1" },
    { COVE_PUBLICATION_COMMAND_TERRITORY: "CA" },
    { COVE_QA_SCHEDULE_OWNER_ENABLED: "0" },
  ]) {
    assert.equal(
      (await serve(request(command()), { ...ownerEnv, ...overrides }, storage, owner)).status,
      503,
    );
    await assert.rejects(
      () => dispatch({ cron: crons[0] }, { ...caller, ...overrides }),
      /not_enrolled/,
    );
  }
  for (const binding of ["DB", "RENAMED_DATABASE"])
    await assert.rejects(
      () => dispatch({ cron: crons[0] }, { ...caller, [binding]: db }),
      /not_enrolled/,
    );
  assert.equal(invocations, before, "Adversarial requests must never reach business work");
  for (const receipt of [
    { ...first, completed: false },
    { ...first, cron: "other" },
    { ...first, sql: "hidden" },
    {},
  ]) {
    await assert.rejects(
      () =>
        dispatch(
          { cron: crons[0] },
          {
            ...caller,
            LEGAL_AUTHORITY: {
              getByName() {
                return {
                  fetch: async () =>
                    Response.json(receipt, { headers: { "cache-control": "no-store" } }),
                };
              },
            },
          },
        ),
      /receipt_invalid/,
    );
  }
  console.log(
    "PASS: private schedule lease, native-handle isolation, domain fences, exact replay, lost acknowledgement, concurrent pending and permanent failure receipts",
  );
} finally {
  delete globalThis.__coveJobCapture;
  delete globalThis.__coveJobTask;
  sqlite.close();
  rmSync(folder, { recursive: true, force: true });
}
