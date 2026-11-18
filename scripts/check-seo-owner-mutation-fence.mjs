import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import workerd from "workerd";
import ts from "typescript";

// Real owner schema and functions; no cloud account, credentials or real D1.
const temp = mkdtempSync(path.join(tmpdir(), "cove-owner-mutation-"));
let runtime;
try {
  await build({
    entryPoints: [
      "scripts/staging/seo-owner-mutation-fixture.ts",
      "src/storefront-strangler/seo-owner-mutation-fence-qa.ts",
      "src/features/fore/seo-count-projection.ts",
    ],
    outdir: temp,
    entryNames: "[name]",
    bundle: true,
    format: "esm",
    platform: "node",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const fixture = await import(pathToFileURL(path.join(temp, "seo-owner-mutation-fixture.mjs")));
  const fence = await import(pathToFileURL(path.join(temp, "seo-owner-mutation-fence-qa.mjs")));
  const {
    enrollQaOwnerMutationFence: enroll,
    readQaOwnerMutationFence: read,
    QA_OWNER_MUTATION_TABLES: tables,
  } = fence;
  // Bind the fixture to the REAL constructor's complete factory call list.
  // A newly added factory must never silently escape this table inventory.
  function factoryCalls(filename, constructor) {
    const source = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    assert.equal(source.parseDiagnostics.length, 0);
    const imports = new Map();
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      for (const e of node.importClause?.namedBindings?.elements || [])
        imports.set(
          e.name.text,
          path.resolve(path.dirname(filename), node.moduleSpecifier.text + ".ts"),
        );
    }
    const owner = source.statements.find((node) =>
      constructor
        ? ts.isClassDeclaration(node) && node.name?.text === "CoveLegalAuthority"
        : ts.isFunctionDeclaration(node) && node.name?.text === "createActualOwnerSchema",
    );
    const body = constructor ? owner?.members.find(ts.isConstructorDeclaration)?.body : owner?.body;
    assert.ok(body, "missing reviewed owner constructor/fixture");
    const calls = [];
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
          assert.equal(constructor, true);
          assert.equal(node.arguments.map((arg) => arg.getText(source)).join(","), "ctx,env");
          return;
        }
        assert.ok(ts.isIdentifier(node.expression), "new owner constructor call requires review");
        const name = node.expression.text;
        assert.ok(imports.has(name), "constructor factory must have a reviewed import");
        calls.push([name, imports.get(name)]);
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    return calls;
  }
  const ownerFactories = factoryCalls("src/storefront-strangler/legal-authority.worker.ts", true);
  const fixtureFactories = factoryCalls("scripts/staging/seo-owner-mutation-fixture.ts", false);
  assert.equal(ownerFactories.length, 8);
  assert.deepEqual(fixtureFactories, ownerFactories);
  function database() {
    const db = new DatabaseSync(":memory:");
    const sql = {
      exec(query, ...values) {
        const statement = db.prepare(query);
        const rows = statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
        return { toArray: () => rows };
      },
    };
    let sequence = 0;
    const tx = (fn) => {
      const name = "qa_tx_" + sequence++;
      db.exec("SAVEPOINT " + name);
      try {
        const result = fn();
        db.exec("RELEASE " + name);
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO " + name);
        db.exec("RELEASE " + name);
        throw error;
      }
    };
    fixture.createActualOwnerSchema(sql);
    return { db, sql, tx, close: () => db.close() };
  }
  function enrolled() {
    const a = database();
    assert.equal(enroll(a.sql, a.tx, fixture.VERSION), 0);
    return a;
  }
  const a = enrolled();
  const result = fixture.runActualOwnerDenials(a.sql, a.tx);
  assert.equal(result.commands, 9);
  assert.equal(result.rolledBack, true);
  assert.equal(result.after.authorizing, false);
  assert.equal(result.after.tables, 24);
  assert.equal(result.after.triggers, 78);
  const { verifiedSeoCountsForServing } = await import(
    pathToFileURL(path.join(temp, "seo-count-projection.mjs"))
  );
  const now = Date.now();
  const epochs = {
    ownerVersion: fixture.VERSION,
    ownerDenialEpoch: "0",
    catalogGeneration: "1",
    rightsGeneration: "1",
    withdrawalGeneration: "1",
    taxonomyGeneration: "1",
    contributorGeneration: "1",
  };
  const evidence = {
    snapshot: {
      schema: "cove.seo.counts.v1",
      ...epochs,
      createdAtMs: now,
      expiresAtMs: now + 1000,
      eligibilityValidUntilMs: now + 1000,
      counts: { books: 1, works: 1, editions: 1, authors: 1, categories: 1 },
    },
    fence: {
      ...epochs,
      ownerEnabled: true,
      exclusiveWriter: true,
      primaryD1: true,
      dirty: false,
      pendingWithdrawals: 0,
      pendingWrites: 0,
      eligibilityValidUntilMs: now + 1000,
    },
    ownerDenialProof: {
      schema: "cove.seo.owner-denial-epoch.v1",
      ownerVersion: fixture.VERSION,
      denialEpoch: "0",
      authority: "canonical-legal-durable-object",
    },
  };
  assert.ok(verifiedSeoCountsForServing(evidence, now));
  evidence.ownerDenialProof = result.after;
  assert.equal(
    verifiedSeoCountsForServing(evidence, now),
    null,
    "QA receipt must never authorize sitemap output",
  );
  a.close();

  // Every INSERT/UPDATE/DELETE trigger is exercised against the ACTUAL DDL.
  // Generic rows test invalidation coverage, not legal positive authority.
  const field = {
    source_id: "2701",
    territory: "US",
    currency: "USD",
    verdict: "deny",
    state: "pending",
    subject_kind: "contract",
    subject_id: "contract_qa",
    operation_id: "qa-op-1",
    entitlement_id: "entitlement_qa_001",
    order_id: "order_qa_001",
    user_id: "user_qa_001",
    product_id: "prd_qa_product",
    edition_id: "edition_qa",
    grant_id: "grant_qa",
    contract_id: "contract_qa",
    contract_version_id: "version_qa",
    scope: "qa",
    after_operation_id: "",
    command_sha256: "a".repeat(64),
    payload_sha256: "b".repeat(64),
  };
  for (const table of tables) {
    const b = enrolled();
    try {
      const columns = b.db.prepare(`PRAGMA table_info("${table}")`).all();
      if (table === "cove_publication_recovery_scan") b.db.exec(`DELETE FROM "${table}"`);
      if (table === "cove_paid_entitlement_scopes")
        b.db
          .prepare("INSERT INTO cove_paid_entitlement_orders VALUES(?,?)")
          .run(field.entitlement_id, field.order_id);
      const initial = Number(read(b.sql, b.tx, fixture.VERSION).mutationEpoch);
      const values = columns.map(
        (c) => field[c.name] ?? (c.type.includes("INT") ? 1 : "qa_fixture"),
      );
      b.db
        .prepare(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c.name}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .run(...values);
      assert.equal(
        Number(read(b.sql, b.tx, fixture.VERSION).mutationEpoch),
        initial + 1,
        table + " insert",
      );
      b.db.exec(`UPDATE "${table}" SET "${columns[0].name}"="${columns[0].name}"`);
      assert.equal(
        Number(read(b.sql, b.tx, fixture.VERSION).mutationEpoch),
        initial + 2,
        table + " update",
      );
      b.db.exec(`DELETE FROM "${table}"`);
      assert.equal(
        Number(read(b.sql, b.tx, fixture.VERSION).mutationEpoch),
        initial + 3,
        table + " delete",
      );
    } finally {
      b.close();
    }
  }
  for (const mutation of [
    "CREATE TABLE unreviewed_authority(id TEXT)",
    "CREATE VIEW unreviewed_view AS SELECT 1",
    "ALTER TABLE cove_legal_fences ADD COLUMN unreviewed TEXT",
    "DROP TRIGGER qa_owner_mutation_0_insert",
  ]) {
    const b = enrolled();
    b.db.exec(mutation);
    assert.throws(() => read(b.sql, b.tx, fixture.VERSION), /qa_owner_mutation_/);
    assert.throws(
      () => enroll(b.sql, b.tx, fixture.VERSION),
      /qa_owner_mutation_/,
      "damaged fence must not auto-repair",
    );
    b.close();
  }
  for (const prior of [
    "INSERT INTO cove_market_withdrawals VALUES('US','old','2026-01-01T00:00:00Z')",
    "INSERT INTO cove_paid_refunded_orders VALUES('order_old')",
    "UPDATE cove_publication_recovery_scan SET after_operation_id='old'",
  ]) {
    const b = database();
    b.db.exec(prior);
    assert.throws(() => enroll(b.sql, b.tx, fixture.VERSION), /nonvirgin/);
    assert.equal(
      b.db
        .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='cove_qa_owner_mutation_fence'")
        .get().n,
      0,
    );
    b.close();
  }
  const forged = enrolled();
  forged.db.exec("DROP TRIGGER qa_owner_mutation_0_insert");
  forged.db.exec(
    `CREATE TRIGGER qa_owner_mutation_0_insert AFTER INSERT ON cove_authorized_offer_proofs BEGIN UPDATE cove_qa_owner_mutation_fence SET epoch=epoch; END`,
  );
  assert.throws(() => read(forged.sql, forged.tx, fixture.VERSION), /trigger_changed/);
  assert.throws(() => enroll(forged.sql, forged.tx, fixture.VERSION), /trigger_changed/);
  forged.close();
  for (const damage of [
    "DELETE FROM cove_qa_owner_mutation_fence",
    "UPDATE cove_qa_owner_mutation_fence SET owner_version='wrong'",
    "UPDATE cove_qa_owner_mutation_fence SET epoch=0",
    "INSERT OR REPLACE INTO cove_qa_owner_mutation_fence(slot,owner_version,epoch) SELECT slot,owner_version,0 FROM cove_qa_owner_mutation_fence",
    "REPLACE INTO cove_qa_owner_mutation_fence(slot,owner_version,epoch) SELECT slot,owner_version,0 FROM cove_qa_owner_mutation_fence",
    "INSERT INTO cove_qa_owner_mutation_fence(slot,owner_version,epoch) SELECT slot,owner_version,0 FROM cove_qa_owner_mutation_fence WHERE true ON CONFLICT(slot) DO UPDATE SET epoch=0",
    "DELETE FROM cove_qa_owner_mutation_manifest WHERE table_name='cove_legal_fences'",
    "UPDATE cove_qa_owner_mutation_manifest SET table_sql='forged'",
    "INSERT INTO cove_qa_owner_mutation_manifest VALUES('forged','forged')",
  ]) {
    const broken = enrolled();
    broken.db.exec("UPDATE cove_qa_owner_mutation_fence SET epoch=epoch+1");
    // A normal owner write must never reset its counter or rewrite its manifest.
    assert.throws(() => broken.db.exec(damage), /immutable/);
    assert.equal(read(broken.sql, broken.tx, fixture.VERSION).mutationEpoch, "1");
    broken.close();
  }
  const missingCounter = enrolled();
  missingCounter.db.exec("DROP TRIGGER qa_owner_fence_delete");
  missingCounter.db.exec("DELETE FROM cove_qa_owner_mutation_fence");
  assert.throws(
    () => missingCounter.db.exec("INSERT INTO cove_paid_refunded_orders VALUES('order_blocked')"),
    /fence_unavailable/,
  );
  assert.equal(
    missingCounter.db.prepare("SELECT COUNT(*) n FROM cove_paid_refunded_orders").get().n,
    0,
  );
  missingCounter.close();
  const exhausted = enrolled();
  // Fixture-only injection of a legitimately exhausted persisted counter.
  const guard = exhausted.db
    .prepare("SELECT sql FROM sqlite_master WHERE name='qa_owner_fence_update'")
    .get().sql;
  exhausted.db.exec("DROP TRIGGER qa_owner_fence_update");
  exhausted.db.exec("UPDATE cove_qa_owner_mutation_fence SET epoch=9007199254740991");
  exhausted.db.exec(guard);
  assert.throws(
    () => exhausted.db.exec("INSERT INTO cove_paid_refunded_orders VALUES('order_exhausted')"),
    /fence_unavailable/,
  );
  assert.equal(exhausted.db.prepare("SELECT COUNT(*) n FROM cove_paid_refunded_orders").get().n, 0);
  exhausted.close();
  // Check real bundle inputs, including transitive imports, rather than just
  // checking one source import spelling. Neither shipping entry may reach QA.
  const production = await build({
    entryPoints: [
      "src/storefront-strangler/legal-authority.worker.ts",
      "src/features/fore/seo.server.ts",
    ],
    outdir: path.join(temp, "production-source"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "worker", "browser", "import", "default"],
    alias: { jszip: "jszip/dist/jszip.min.js" },
    external: ["node:*", "cloudflare:*"],
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  assert.deepEqual(
    Object.values(production.metafile.outputs)
      .map((output) => output.entryPoint)
      .filter(Boolean)
      .sort(),
    ["src/features/fore/seo.server.ts", "src/storefront-strangler/legal-authority.worker.ts"],
  );
  assert.ok(
    Object.keys(production.metafile.inputs).includes(
      "src/storefront-strangler/legal-authority-core.ts",
    ),
  );
  assert.equal(
    Object.keys(production.metafile.inputs).some((p) =>
      p.endsWith("/seo-owner-mutation-fence-qa.ts"),
    ),
    false,
    "shipping owner/sitemap bundle must not reach the QA prototype",
  );
  console.log(
    "PASS Node SQLite: 24 actual owner tables, 72 atomic DML triggers, 9 real denial commands/replays, rollback, schema damage, historical bootstrap and exhaustion",
  );

  const { outputFiles } = await build({
    stdin: {
      contents: `import {MutationFenceFixture} from './scripts/staging/seo-owner-mutation-fixture.ts';
export {MutationFenceFixture};
export default {fetch(request,env){return env.OWNER.get(env.OWNER.idFromName('isolated-fixture')).fetch(request);}};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  writeFileSync(path.join(temp, "worker.mjs"), outputFiles[0].text);
  mkdirSync(path.join(temp, "storage"));
  writeFileSync(
    path.join(temp, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
services = [(name="main", worker=(modules=[(name="worker.mjs",esModule=embed "worker.mjs")],
compatibilityDate="${workerd.compatibilityDate}",
bindings=[(name="OWNER",durableObjectNamespace="MutationFenceFixture")],
durableObjectNamespaces=[(className="MutationFenceFixture",uniqueKey="cove-isolated-mutation-test",enableSql=true)],
durableObjectStorage=(localDisk="data"))),
(name="data",disk=(path=${JSON.stringify(path.join(temp, "storage"))},writable=true))],
sockets=[(name="http",address="127.0.0.1:0",http=(),service="main")]);`,
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
        const message = JSON.parse(line);
        if (message.event === "listen" && message.socket === "http") {
          clearTimeout(timer);
          runtime.off("error", fail);
          runtime.off("exit", fail);
          lines.close();
          resolve(message.port);
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
  const request = async (port, endpoint) => {
    const response = await fetch(`http://127.0.0.1:${port}/${endpoint}`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(
      response.status,
      200,
      "local DO rejected request: " + (await response.clone().text()),
    );
    return response.json();
  };
  let port = await start();
  const initial = await request(port, "read");
  assert.equal(initial.mutationEpoch, "0");
  const exercised = await request(port, "exercise");
  assert.equal(exercised.commands, 9);
  assert.equal(exercised.rolledBack, true);
  assert.ok(Number(exercised.after.mutationEpoch) > 0);
  const primary = new DatabaseSync(":memory:");
  primary.exec("CREATE TABLE published_snapshot(epoch TEXT NOT NULL)");
  primary.prepare("INSERT INTO published_snapshot VALUES(?)").run(exercised.after.mutationEpoch);
  const denied = await request(port, "withdraw-again");
  assert.notEqual(
    denied.mutationEpoch,
    primary.prepare("SELECT epoch FROM published_snapshot").get().epoch,
    "owner denial must invalidate the old primary snapshot before reconciliation",
  );
  await stop();
  port = await start();
  const restarted = await request(port, "read");
  assert.deepEqual(restarted, denied, "fresh isolate must retain the durable mutation epoch");
  assert.equal(restarted.authorizing, false);
  primary.close();
  await stop();
  console.log(
    "PASS pinned workerd: real SQLite Durable Object triggers/transactions, cross-store denial gap and epoch persistence across process restart",
  );
} finally {
  if (runtime && runtime.exitCode === null) {
    const done = once(runtime, "exit");
    runtime.kill();
    await done;
  }
  rmSync(temp, { recursive: true, force: true });
}
