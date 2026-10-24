import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = mkdtempSync(path.join(tmpdir(), "cove-literary-owner-"));
const sqlite = new DatabaseSync(":memory:");
let flipAfterPreflight = false;
const source = readFileSync("src/features/fore/literary-profiles.server.ts", "utf8");
assert.match(source, /j\.created_at,j\.id LIMIT 1\) AND \$\{legacyOwnerFenceSql\} RETURNING/);
assert.match(source, /SELECT \?,\?,\?,\?,\?,\?,\?,\?,\? WHERE \$\{legacyOwnerFenceSql\}/);
function wrap() {
  return {
    prepare(text) {
      const statement = sqlite.prepare(text);
      function binding(...values) {
        return {
          async first() {
            const row = statement.get(...values) ?? null;
            if (
              flipAfterPreflight &&
              text === "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'"
            ) {
              flipAfterPreflight = false;
              sqlite.prepare(
                "UPDATE cove_runtime_config SET value='draining' WHERE key='literary_processing_owner'",
              ).run();
            }
            return row;
          },
          async run() {
            return statement.run(...values);
          },
          async all() {
            return { results: statement.all(...values) };
          },
        };
      }
      return { bind: (...values) => binding(...values), ...binding() };
    },
  };
}
try {
  sqlite.exec(`
    CREATE TABLE cove_runtime_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE literary_profiles(product_id TEXT PRIMARY KEY,fingerprint TEXT,status TEXT);
    CREATE TABLE literary_profile_jobs(
      id TEXT PRIMARY KEY,product_id TEXT,fingerprint TEXT,kind TEXT,section_id TEXT DEFAULT '',
      source_key TEXT DEFAULT '',status TEXT DEFAULT 'queued',attempts INTEGER DEFAULT 0,
      available_at TEXT,lease_token TEXT DEFAULT '',lease_until TEXT DEFAULT '',
      last_error TEXT DEFAULT '',created_at TEXT,updated_at TEXT
    );
    CREATE TABLE literary_profile_state(
      id INTEGER PRIMARY KEY,cursor TEXT DEFAULT '',lease_token TEXT DEFAULT '',
      lease_until TEXT DEFAULT '',last_run_at TEXT DEFAULT ''
    );
    INSERT INTO literary_profile_state(id) VALUES(1);
    INSERT INTO literary_profiles VALUES('book','fingerprint','provisional');
    INSERT INTO literary_profile_jobs(id,product_id,fingerprint,kind,available_at,created_at,updated_at)
      VALUES('job','book','fingerprint','prepare','2099-01-01','2020-01-01','2020-01-01');
  `);
  await build({
    entryPoints: ["src/features/fore/literary-profiles.server.ts"],
    outfile: path.join(dir, "literary.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { processLiteraryJob, seedLiteraryProfiles, runLiteraryProfileTick, readLiteraryProcessingOwner } =
    await import(pathToFileURL(path.join(dir, "literary.mjs")).href);
  const env = { DB: wrap() };
  const row = () => sqlite.prepare("SELECT status,attempts FROM literary_profile_jobs WHERE id='job'").get();
  const changes = () => sqlite.prepare("SELECT total_changes() n").get().n;
  assert.equal(await readLiteraryProcessingOwner(env), "legacy", "Absent key keeps legacy active");
  assert.deepEqual(await processLiteraryJob(env, false, "prepare"), { skipped: "no_jobs" });
  sqlite.prepare("INSERT INTO cove_runtime_config VALUES('literary_processing_owner','draining')").run();
  const before = changes();
  assert.deepEqual(await runLiteraryProfileTick(env), { skipped: "legacy_owner_fenced" });
  assert.deepEqual(await seedLiteraryProfiles(env), { seeded: 0, skipped: "legacy_owner_fenced" });
  assert.deepEqual(await processLiteraryJob(env, false, "prepare"), { skipped: "legacy_owner_fenced" });
  assert.equal(changes(), before, "Draining must have zero scheduled legacy writes");
  assert.deepEqual(row(), { status: "queued", attempts: 0 });
  sqlite.prepare("UPDATE cove_runtime_config SET value='typo'").run();
  assert.deepEqual(await processLiteraryJob(env, false, "prepare"), { skipped: "legacy_owner_fenced" });
  assert.deepEqual(await runLiteraryProfileTick(env), { skipped: "legacy_owner_fenced" });
  // Race: a worker reads legacy, then the operator fences D1 before its
  // claim statement executes. The atomic predicate must prevent a claim.
  sqlite.prepare("UPDATE cove_runtime_config SET value='legacy'").run();
  sqlite.prepare("UPDATE literary_profile_jobs SET available_at='2020-01-01'").run();
  flipAfterPreflight = true;
  assert.deepEqual(await processLiteraryJob(env, false, "prepare"), { skipped: "no_jobs" });
  assert.equal(flipAfterPreflight, false);
  assert.equal(await readLiteraryProcessingOwner(env), "draining");
  assert.deepEqual(row(), { status: "queued", attempts: 0 });
  sqlite.prepare("UPDATE cove_runtime_config SET value='isolated'").run();
  assert.deepEqual(await runLiteraryProfileTick(env), { skipped: "legacy_owner_fenced" });
  assert.deepEqual(await processLiteraryJob(env, false, "prepare"), { skipped: "legacy_owner_fenced" });
  assert.deepEqual(row(), { status: "queued", attempts: 0 });
  console.log("LITERARY_OWNER_CUTOVER_PASS legacy default, draining/isolated/unknown fence, atomic claim race, no new primary writes");
} finally {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
}
