import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import workerd from "workerd";

const temp = mkdtempSync(path.join(tmpdir(), "cove-current-owner-"));
const version = "a".repeat(64),
  secret = "b".repeat(64),
  challenge = "c".repeat(32);
const primaryId = "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const route = "/qa/current-mutation-fence";
const journalTable = "cove_qa_current_owner_mutation_fence";
const request = (endpoint, body, bearer = secret) =>
  new Request("https://legal-authority.internal" + endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const commands = [
  ["/deny-next", { sourceId: "2701", territory: "*", operationId: "source-current-1" }],
  ["/market/deny-next", { territory: "CA", operationId: "market-current-1" }],
  ["/commercial/deny-next", { productId: "prd_current_test", operationId: "product-current-1" }],
  [
    "/commercial/subject/deny-next",
    { subjectKind: "contract", subjectId: "contract_current", operationId: "contract-current-1" },
  ],
  [
    "/commercial/subject/deny-next",
    { subjectKind: "grant", subjectId: "grant_current", operationId: "grant-current-1" },
  ],
  [
    "/commercial/order/deny-next",
    { orderId: "order_current_test", operationId: "order-current-1" },
  ],
  [
    "/commercial/entitlement/deny-next",
    {
      entitlementId: "entitlement_current",
      userId: "user_current_test",
      productId: "prd_current_paid",
      operationId: "entitlement-current-1",
    },
  ],
];
const databases = [];
let runtime;
try {
  const outfile = path.join(temp, "owner.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/legal-authority.worker.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    plugins: [
      {
        name: "test-host",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "host",
            namespace: "host",
          }));
          b.onLoad({ filter: /.*/, namespace: "host" }, () => ({
            contents:
              "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}",
          }));
        },
      },
    ],
  });
  const { CoveLegalAuthority, default: entry } = await import(pathToFileURL(outfile));
  function fixture({ enrolled = true, db = new DatabaseSync(":memory:"), envPatch = {} } = {}) {
    if (!databases.includes(db)) databases.push(db);
    let sqlFault = () => {};
    // Cloudflare exec is eager, including when the cursor is not read.
    const sql = {
      exec(q, ...args) {
        sqlFault(q, args);
        const stmt = db.prepare(q);
        const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
        return { toArray: () => rows };
      },
    };
    let beforeBatch = async () => {};
    const primary = {
      prepare(q) {
        assert.match(q, /commerce_orders|UPDATE /);
        return {
          bind() {
            return this;
          },
          async first() {
            return { id: "order_reconcile_test", user_id: "user_current_test" };
          },
        };
      },
      async batch() {
        await beforeBatch();
        throw Error("injected primary reconciliation outage");
      },
    };
    const env = {
      PRIMARY_DB: primary,
      COVE_RIGHTS_OWNER_ENABLED: "1",
      COVE_RIGHTS_OWNER_PRIMARY_ID: primaryId,
      COVE_RIGHTS_OWNER_SECRET: secret,
      COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 10 * 60_000),
      ...(enrolled ? { COVE_QA_OWNER_JOURNAL_VERSION: version } : {}),
      ...envPatch,
    };
    const storage = {
      sql,
      transactionSync(fn) {
        db.exec("BEGIN");
        try {
          const r = fn();
          db.exec("COMMIT");
          return r;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    };
    const owner = new CoveLegalAuthority({ storage }, env);
    env.LEGAL_AUTHORITY = {
      getByName(name) {
        assert.equal(name, "cove-staged-legal-global-v1");
        return owner;
      },
    };
    const post = (r, body, bearer) => entry.fetch(request(r, body, bearer), env);
    const read = async () => {
      const response = await post(route, { challenge });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const receipt = await response.json();
      assert.equal(receipt.challenge, challenge);
      assert.equal(receipt.authorizing, false);
      assert.equal(receipt.primaryId, primaryId);
      assert.equal(receipt.tables, 24);
      assert.equal(receipt.triggers, 78);
      assert.equal(receipt.journalVersion, version);
      return receipt;
    };
    return {
      setSqlFault(fn) {
        sqlFault = fn;
      },
      db,
      env,
      owner,
      post,
      read,
      setBeforeBatch(fn) {
        beforeBatch = fn;
      },
    };
  }
  const f = fixture();
  assert.equal((await f.read()).mutationEpoch, "0");
  for (const [r, command] of commands) {
    const before = (await f.read()).mutationEpoch;
    assert.equal((await f.post(r, command)).status, 200, r);
    const after = (await f.read()).mutationEpoch;
    assert.ok(
      Number(after) > Number(before),
      "actual ACK must follow durable journal advance: " + r,
    );
    assert.equal((await f.post(r, command)).status, 200);
    assert.equal((await f.read()).mutationEpoch, after, "idempotent replay must not advance " + r);
  }
  // Cross-service integration against the REAL legal owner handlers and
  // their SQLite-backed durable mutation journal, not a fabricated receipt.
  // The primary row is deliberately synthetic because a certified owner
  // publisher/generation CAS has NOT been deployed to any real D1.
  const bracketFile = path.join(temp, "bracket.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/current-owner-primary-read-bracket.stage.ts"],
    outfile: bracketFile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { withCurrentQaOwnerPrimaryRead, QA_OWNER_PRIMARY_FENCE_SQL } = await import(
    pathToFileURL(bracketFile)
  );
  f.env.COVE_QA_OWNER_REHEARSAL_REVISION = "A";
  const generation = Number((await f.read()).mutationEpoch);
  const primaryRow = {
    publication_schema: "cove.qa.owner-primary-read-bracket.v1",
    primary_id: primaryId,
    owner_journal_version: version,
    owner_mutation_epoch: generation,
    owner_rehearsal_revision: "A",
    dirty: 0,
    pending_withdrawals: 0,
    pending_writes: 0,
    eligibility_valid_until_ms: Date.now() + 120_000,
  };
  let primaryReadCount = 0;
  const bracket = {
    owner: f.owner,
    secret,
    primaryId,
    journalVersion: version,
    primary: {
      withSession(constraint) {
        assert.equal(constraint, "first-primary");
        return {
          prepare(sqlText) {
            assert.equal(sqlText, QA_OWNER_PRIMARY_FENCE_SQL);
            return {
              async first() {
                primaryReadCount++;
                return { ...primaryRow };
              },
            };
          },
        };
      },
    },
  };
  assert.equal(
    await withCurrentQaOwnerPrimaryRead(bracket, async () => "rights-checked-book"),
    "rights-checked-book",
    "actual owner journal and independently versioned primary witness agree",
  );
  assert.equal(primaryReadCount, 3);
  let producedUnreleasedBook = false;
  await assert.rejects(
    withCurrentQaOwnerPrimaryRead(bracket, async () => {
      // The owner ACKs its new denial before primary publication catches up.
      const deny = await f.post("/market/deny-next", {
        territory: "DE",
        operationId: "qa-read-bracket-race-1",
      });
      assert.equal(deny.status, 200);
      producedUnreleasedBook = true;
      return "stale-primary-legal-book";
    }),
    /qa_owner_primary_read_not_current/,
    "a genuine owner-ACK withdrawal may not release the older D1 result",
  );
  assert.equal(producedUnreleasedBook, true);
  assert.ok(
    Number((await f.read()).mutationEpoch) > generation,
    "the actual owner mutation journal is already ahead of the mock primary",
  );
  assert.equal(primaryRow.owner_mutation_epoch, generation);
  // Use the ACTUAL Durable Object's current owner epoch to drive a real
  // atomic SQLite UPDATE..RETURNING. Only primary D1 transport is local.
  // This staged fixture remains sealed/dirty, never a paid/read authority.
  const negativeFile = path.join(temp, "negative-primary.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/owner-primary-denial-publication.stage.ts"],
    outfile: negativeFile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { advanceQaPrimaryDenialEpoch, QA_NEGATIVE_PRIMARY_CAS_SQL } = await import(
    pathToFileURL(negativeFile)
  );
  const negativeDb = new DatabaseSync(":memory:");
  databases.push(negativeDb);
  negativeDb.exec(
    readFileSync("scripts/staging/qa-owner-negative-primary-publication.prototype.sql", "utf8"),
  );
  let denyPrimaryWrites = false;
  const negativePort = {
    withSession(mode) {
      assert.equal(mode, "first-primary");
      return {
        prepare(query) {
          const stmt = negativeDb.prepare(query);
          let bindings = [];
          return {
            bind(...values) {
              bindings = values;
              return this;
            },
            async first() {
              if (query === QA_NEGATIVE_PRIMARY_CAS_SQL && denyPrimaryWrites)
                throw Error("injected primary CAS outage");
              return stmt.get(...bindings) || null;
            },
          };
        },
      };
    },
  };
  const negativeContext = {
    owner: f.owner,
    primary: negativePort,
    secret,
    primaryId,
    journalVersion: version,
  };
  const firstPublication = await advanceQaPrimaryDenialEpoch(negativeContext);
  assert.equal(firstPublication.ownerFirst, true);
  assert.equal(firstPublication.negativeOnly, true);
  assert.equal(firstPublication.authorizing, false);
  assert.equal(firstPublication.applied, true);
  assert.equal(firstPublication.ownerEpoch, Number((await f.read()).mutationEpoch));
  const published = negativeDb
    .prepare(
      "SELECT owner_mutation_epoch,dirty,pending_withdrawals,eligibility_valid_until_ms FROM cove_qa_owner_primary_publication_fence WHERE slot=1",
    )
    .get();
  assert.equal(published.owner_mutation_epoch, firstPublication.ownerEpoch);
  assert.equal(published.dirty, 1);
  assert.equal(published.eligibility_valid_until_ms, 0);
  assert.equal((await advanceQaPrimaryDenialEpoch(negativeContext)).applied, false);
  // The real owner acknowledges a new withdrawal before D1 catches up.
  const confirmedDeny = await f.post("/market/deny-next", {
    territory: "GB",
    operationId: "qa-primary-actual-owner-withdraw-1",
  });
  assert.equal(confirmedDeny.status, 200);
  const deniedEpoch = Number((await f.read()).mutationEpoch);
  assert.ok(deniedEpoch > firstPublication.ownerEpoch);
  denyPrimaryWrites = true;
  await assert.rejects(advanceQaPrimaryDenialEpoch(negativeContext), /injected primary CAS outage/);
  assert.equal(
    negativeDb
      .prepare("SELECT owner_mutation_epoch FROM cove_qa_owner_primary_publication_fence")
      .get().owner_mutation_epoch,
    firstPublication.ownerEpoch,
    "D1 outage cannot roll back the already acknowledged owner denial",
  );
  denyPrimaryWrites = false;
  const recoveredPublication = await advanceQaPrimaryDenialEpoch(negativeContext);
  assert.equal(recoveredPublication.ownerEpoch, deniedEpoch);
  assert.equal(recoveredPublication.applied, true);
  assert.equal(
    negativeDb.prepare("SELECT dirty FROM cove_qa_owner_primary_publication_fence").get().dirty,
    1,
    "a recovered denial must never automatically reopen rights",
  );
  assert.equal((await f.post(route, { challenge: "bad" })).status, 400);
  assert.equal((await f.post(route, { challenge, extra: true })).status, 400);
  assert.equal((await f.post(route, { challenge }, "d".repeat(64))).status, 401);
  assert.equal((await fixture({ enrolled: false }).post(route, { challenge })).status, 503);
  for (const patch of [
    { COVE_RIGHTS_OWNER_ENABLED: "0" },
    { COVE_RIGHTS_OWNER_PRIMARY_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
    { COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: "1" },
  ]) {
    const disabled = fixture({ envPatch: patch });
    assert.equal((await disabled.post(route, { challenge })).status, 503);
    assert.equal(
      disabled.db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(journalTable),
      undefined,
      "never enroll production/expired/disabled owner",
    );
  }
  // Read the actual owner while an already durable refund awaits D1. The
  // independent primary snapshot deliberately has no reconciliation advance.
  const snapshot = (await f.read()).mutationEpoch;
  let interleaved;
  f.setBeforeBatch(async () => {
    interleaved = await f.read();
    assert.notEqual(
      interleaved.mutationEpoch,
      snapshot,
      "stale primary snapshot must be distinguishable before D1 commit",
    );
    const verify = await f.post("/commercial/order/verify", { orderId: "order_reconcile_test" });
    assert.equal((await verify.json()).allowed, false);
  });
  assert.equal(
    (
      await f.post("/commercial/order/revoke", {
        orderId: "order_reconcile_test",
        operationId: "reconcile-current-1",
      })
    ).status,
    503,
  );
  assert.equal(
    (await f.read()).mutationEpoch,
    interleaved.mutationEpoch,
    "D1 failure must not roll back durable denial",
  );
  const otherChallenge = "d".repeat(32);
  const fresh = await (await f.post(route, { challenge: otherChallenge })).json();
  assert.equal(fresh.challenge, otherChallenge, "owner must bind the actual request challenge");
  assert.equal(fresh.authorizing, false);
  for (const q of [
    `UPDATE ${journalTable} SET epoch=0`,
    `DELETE FROM ${journalTable}`,
    `INSERT OR REPLACE INTO ${journalTable}(slot,journal_version,epoch) VALUES(1,'${version}',0)`,
  ])
    assert.throws(() => f.db.exec(q), /immutable/);
  const exhausted = fixture();
  const guard = exhausted.db
    .prepare("SELECT sql FROM sqlite_master WHERE name='qa_current_owner_fence_update'")
    .get().sql;
  exhausted.db.exec("DROP TRIGGER qa_current_owner_fence_update");
  exhausted.db.exec(`UPDATE ${journalTable} SET epoch=9007199254740991`);
  exhausted.db.exec(guard);
  assert.equal((await exhausted.post(...commands[5])).status, 503);
  assert.equal(
    exhausted.db.prepare("SELECT COUNT(*) n FROM cove_paid_refunded_orders").get().n,
    0,
    "exhaustion aborts the original denial rather than acknowledging an untracked change",
  );
  const stable = (await f.read()).mutationEpoch;
  const restarted = fixture({ db: f.db });
  assert.equal((await restarted.read()).mutationEpoch, stable);
  restarted.env.COVE_QA_OWNER_REHEARSAL_REVISION = "B";
  assert.equal((await restarted.read()).rehearsalRevision, "B");
  restarted.env.COVE_QA_OWNER_REHEARSAL_REVISION = "invalid";
  assert.equal((await restarted.post(route, { challenge })).status, 503);
  restarted.env.COVE_QA_OWNER_REHEARSAL_REVISION = "A";
  assert.equal((await restarted.read()).mutationEpoch, stable);
  // Transaction failure after several row mutations rolls back state and epoch.
  const batched = fixture();
  batched.db.exec(
    "CREATE TRIGGER inject_second BEFORE INSERT ON cove_legal_denial_operations WHEN NEW.source_id='2702' BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  // The manifest independently rejects even an extra trigger before mutation.
  assert.equal(
    (
      await batched.post("/deny-next", {
        sourceId: "2701",
        territory: "*",
        operationId: "damage-1",
      })
    ).status,
    503,
  );
  assert.equal(batched.db.prepare("SELECT COUNT(*) n FROM cove_legal_fences").get().n, 0);
  const atomic = fixture();
  atomic.setSqlFault((q, args) => {
    if (q.startsWith("INSERT INTO cove_legal_denial_operations") && args[1] === "2702")
      throw Error("injected second denial failure");
  });
  assert.equal(
    (
      await atomic.post("/deny-next-batch", {
        operations: [
          { sourceId: "2701", territory: "*", operationId: "atomic-1" },
          { sourceId: "2702", territory: "*", operationId: "atomic-2" },
        ],
      })
    ).status,
    503,
  );
  assert.equal((await atomic.read()).mutationEpoch, "0", "failed actual batch rolls epoch back");
  assert.equal(atomic.db.prepare("SELECT COUNT(*) n FROM cove_legal_fences").get().n, 0);
  const damaged = fixture();
  damaged.db.exec("DROP TRIGGER qa_current_owner_mutation_0_insert");
  assert.equal((await damaged.post(route, { challenge })).status, 503);
  assert.equal(
    (
      await damaged.post("/commercial/order/deny-next", {
        orderId: "order_damaged_test",
        operationId: "damage-2",
      })
    ).status,
    503,
  );
  assert.equal(damaged.db.prepare("SELECT COUNT(*) n FROM cove_paid_refunded_orders").get().n, 0);
  assert.throws(
    () => fixture({ db: damaged.db }),
    /trigger_missing/,
    "restart must not repair history gap",
  );
  const historical = fixture({ enrolled: false });
  await historical.post(...commands[0]);
  assert.throws(
    () => fixture({ db: historical.db }),
    /nonvirgin/,
    "historical owner cannot silently become epoch zero",
  );
  console.log(
    "PASS actual owner handlers: seven denial routes/replays, challenge, disabled-production refusal, schema damage, historical refusal, D1 reconciliation race and restart",
  );

  // Repeat through genuine workerd dispatch and actual SQLite DO storage;
  // only the external D1 transport is replaced by an explicit outage adapter.
  const bundle = await build({
    stdin: {
      contents: `
import {CoveLegalAuthority} from './src/storefront-strangler/legal-authority.worker.ts';
export class CurrentOwner extends CoveLegalAuthority {
 constructor(ctx,env){super(ctx,{...env,PRIMARY_DB:{prepare(){return {bind(){return this;},async first(){return {id:'order_reconcile_test',user_id:'user_current_test'};}};},async batch(){throw Error('injected D1 outage');}}});}
}
export default {fetch(request,env){return env.OWNER.get(env.OWNER.idFromName('current-owner-handler')).fetch(request);}};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "worker", "browser", "import", "default"],
    alias: { jszip: "jszip/dist/jszip.min.js" },
    external: ["cloudflare:*", "node:*"],
    write: false,
    logLevel: "silent",
  });
  writeFileSync(path.join(temp, "worker.mjs"), bundle.outputFiles[0].text);
  mkdirSync(path.join(temp, "storage"));
  const vars = {
    COVE_RIGHTS_OWNER_ENABLED: "1",
    COVE_RIGHTS_OWNER_PRIMARY_ID: primaryId,
    COVE_RIGHTS_OWNER_SECRET: secret,
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 10 * 60_000),
    COVE_QA_OWNER_JOURNAL_VERSION: version,
  };
  writeFileSync(
    path.join(temp, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services=[(name="main",worker=(modules=[(name="worker.mjs",esModule=embed "worker.mjs")],compatibilityDate="${workerd.compatibilityDate}",compatibilityFlags=["nodejs_compat"],bindings=[(name="OWNER",durableObjectNamespace="CurrentOwner"),${Object.entries(
      vars,
    )
      .map(([name, text]) => `(name=${JSON.stringify(name)},text=${JSON.stringify(text)})`)
      .join(
        ",",
      )}],durableObjectNamespaces=[(className="CurrentOwner",uniqueKey="cove-current-owner-handler",enableSql=true)],durableObjectStorage=(localDisk="data"))),(name="data",disk=(path=${JSON.stringify(path.join(temp, "storage"))},writable=true))],sockets=[(name="http",address="127.0.0.1:0",http=(),service="main")]);`,
  );
  async function start() {
    runtime = spawn(workerd.default, ["serve", path.join(temp, "config.capnp"), "--control-fd=1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    runtime.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-3000);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("workerd startup timeout: " + stderr)), 10_000);
      const fail = () => {
        clearTimeout(timer);
        reject(Error("workerd startup failed: " + stderr));
      };
      runtime.once("error", fail);
      runtime.once("exit", fail);
      const lines = readline.createInterface({ input: runtime.stdout });
      lines.on("line", (line) => {
        const m = JSON.parse(line);
        if (m.event === "listen" && m.socket === "http") {
          clearTimeout(timer);
          runtime.off("error", fail);
          runtime.off("exit", fail);
          lines.close();
          resolve(m.port);
        }
      });
    });
  }
  async function stop() {
    if (runtime && runtime.exitCode === null) {
      const done = once(runtime, "exit");
      runtime.kill();
      await done;
    }
    runtime = undefined;
  }
  let port = await start();
  const post = (r, body) =>
    fetch(`http://127.0.0.1:${port}${r}`, {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  const read = async () => {
    const r = await post(route, { challenge });
    assert.equal(r.status, 200);
    return r.json();
  };
  assert.equal((await read()).mutationEpoch, "0");
  for (const [r, body] of commands) {
    const before = (await read()).mutationEpoch;
    assert.equal((await post(r, body)).status, 200, r);
    const after = (await read()).mutationEpoch;
    assert.ok(Number(after) > Number(before), r);
    assert.equal((await post(r, body)).status, 200);
    assert.equal((await read()).mutationEpoch, after);
  }
  const beforeFailure = (await read()).mutationEpoch;
  assert.equal(
    (
      await post("/commercial/order/revoke", {
        orderId: "order_reconcile_test",
        operationId: "native-reconcile-1",
      })
    ).status,
    503,
  );
  const denied = await read();
  assert.notEqual(denied.mutationEpoch, beforeFailure);
  await stop();
  port = await start();
  assert.deepEqual(await read(), denied);
  await stop();
  console.log(
    "PASS native workerd: actual owner HTTP handlers, durable SQLite triggers, D1 failure leaves denial, full process restart retains challenge-bound journal",
  );
} finally {
  if (runtime && runtime.exitCode === null) {
    const done = once(runtime, "exit");
    runtime.kill();
    await done;
  }
  for (const db of databases) db.close();
  rmSync(temp, { recursive: true, force: true });
}
