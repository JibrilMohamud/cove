import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const folder = mkdtempSync(path.join(tmpdir(), "cove-content-budget-"));
const db = new DatabaseSync(":memory:");
const make = (s) => ({
  prepare(sql) {
    const p = s.prepare(sql);
    const bound = (...values) => ({
      async first() {
        return p.get(...values) || null;
      },
      async run() {
        return p.run(...values);
      },
      async all() {
        return { results: p.all(...values) };
      },
    });
    return { ...bound(), bind: bound };
  },
  async batch(statements) {
    s.exec("BEGIN IMMEDIATE");
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      s.exec("COMMIT");
      return result;
    } catch (err) {
      s.exec("ROLLBACK");
      throw err;
    }
  },
});
try {
  db.exec(`
    CREATE TABLE value_store(id INTEGER PRIMARY KEY,value TEXT);
    INSERT INTO value_store VALUES(1,'a');
    CREATE TABLE cove_runtime_config(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE catalog_asset_runner(
      id INTEGER PRIMARY KEY,
      lease_token TEXT NOT NULL,lease_until TEXT NOT NULL,started_at TEXT NOT NULL
    );
  `);
  await build({
    entryPoints: ["src/lib/content-worker-budget.server.ts", "src/lib/content-processing-owner.server.ts"],
    outdir: folder,
    outExtension: { ".js": ".mjs" },
    bundle: true, platform: "node", format: "esm", logLevel: "silent",
  });
  const { meterContentAssetEnv, contentBudgetLimits } = await import(
    pathToFileURL(path.join(folder, "content-worker-budget.server.mjs")).href
  );
  const { contentPipelineOwner, assetOwnerPredicate } = await import(
    pathToFileURL(path.join(folder, "content-processing-owner.server.mjs")).href
  );
  const native = make(db);
  assert.equal(await contentPipelineOwner(native, "assets"), "legacy");
  assert.equal(await contentPipelineOwner(native, "literary"), "legacy");
  const leaseSql =
    "INSERT INTO catalog_asset_runner(id,lease_token,lease_until,started_at)" +
    " SELECT 1,?,?,? WHERE " + assetOwnerPredicate +
    " ON CONFLICT(id) DO UPDATE SET lease_token=excluded.lease_token," +
    "lease_until=excluded.lease_until,started_at=excluded.started_at" +
    " WHERE catalog_asset_runner.lease_until<=? AND " + assetOwnerPredicate +
    " RETURNING lease_token";
  const claim = async (owner, token) =>
    native.prepare(leaseSql).bind(token, "2099-01-01", "2020-01-01", owner, "2100-01-01", owner)
      .first();
  assert.ok(await claim("legacy", "old"));
  db.prepare("INSERT INTO cove_runtime_config VALUES('content_assets_owner','draining')").run();
  assert.equal(await claim("legacy", "late"), null);
  assert.equal(await claim("external", "early"), null);
  assert.equal(db.prepare("SELECT lease_token FROM catalog_asset_runner").get().lease_token, "old");
  db.prepare("UPDATE cove_runtime_config SET value='external'").run();
  assert.equal(await claim("legacy", "late"), null);
  assert.ok(await claim("external", "new"));
  assert.equal(db.prepare("SELECT lease_token FROM catalog_asset_runner").get().lease_token, "new");
  const limits = { statements: 3, writes: 1, d1ServiceMs: 1000, r2Bytes: 4, deadlineAt: Date.now() + 2000 };
  const originalR2 = [];
  const r2 = { async put(key, bytes) { originalR2.push([key, bytes.byteLength]); return {}; } };
  const metered = meterContentAssetEnv({ DB: native, BUCKET: r2 }, limits);
  const scoped = metered.env.DB;
  assert.equal((await scoped.prepare("SELECT value FROM value_store WHERE id=1").first()).value, "a");
  await scoped.prepare("UPDATE value_store SET value='b' WHERE id=1").run();
  assert.equal((await scoped.prepare("SELECT value FROM value_store WHERE id=1").first()).value, "b");
  await assert.rejects(scoped.prepare("SELECT value FROM value_store").all(), /budget_exhausted/);
  await assert.rejects(scoped.prepare("UPDATE value_store SET value='c'").run(), /budget_exhausted/);
  assert.equal(metered.usage.d1Statements, 3);
  assert.equal(metered.usage.d1Writes, 1);
  await metered.env.BUCKET.put("a", Uint8Array.from([1, 2, 3]));
  await assert.rejects(metered.env.BUCKET.put("b", Uint8Array.from([1, 2])), /budget_exhausted/);
  assert.equal(metered.usage.r2Bytes, 3);
  assert.deepEqual(originalR2, [["a", 3]]);
  assert.equal(contentBudgetLimits({}).statements, 32);
  assert.equal(contentBudgetLimits({ FORE_CONTENT_MAX_D1_WRITES: "-100" }).writes, 0);
  const overService = meterContentAssetEnv(
    { DB: native }, { ...limits, statements: 20, writes: 10, d1ServiceMs: 0 },
  );
  await assert.rejects(
    overService.env.DB.prepare("SELECT value FROM value_store").first(),
    /budget_exhausted/,
  );
  const expired = meterContentAssetEnv(
    { DB: native }, { ...limits, deadlineAt: Date.now() - 1 },
  );
  await assert.rejects(
    expired.env.DB.prepare("SELECT value FROM value_store").first(),
    /budget_exhausted/,
  );
  // Own the accounting for D1.batches, even when each prepared statement is
  // read-only and a caller attempts to bypass per-statement execute wrapping.
  const batch = meterContentAssetEnv(
    { DB: native }, { ...limits, statements: 1, writes: 1 },
  );
  await assert.rejects(
    batch.env.DB.batch([
      batch.env.DB.prepare("SELECT value FROM value_store"),
      batch.env.DB.prepare("SELECT value FROM value_store"),
    ]),
    /budget_exhausted/,
  );
  const ownerSource = readFileSync("src/features/fore/catalog-assets.server.ts", "utf8");
  assert.match(ownerSource, /WHERE \$\{assetOwnerPredicate\} RETURNING lease_token/);
  console.log(
    "CONTENT_WORKER_BUDGET_PASS canonical ownership and drain-fenced atomic lease, statements, writes, bytes, service/deadline, and batch accounting",
  );
} finally {
  db.close();
  rmSync(folder, { recursive: true, force: true });
}
