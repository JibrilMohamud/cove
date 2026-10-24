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
// The drain is also an *in-flight publication* fence, not merely a new-claim
// fence. A worker that already holds a lease must not publish a late result.
for (const fragment of [
  "const guard = `EXISTS(SELECT 1 FROM literary_profile_jobs",
  "j.lease_until>?) AND ${legacyOwnerFenceSql}`",
  "status='done' AND ${legacyOwnerFenceSql}",
  "status='running' AND ${legacyOwnerFenceSql}",
  "'provisional',?,?,?,? WHERE ${legacyOwnerFenceSql} ON CONFLICT",
  "excluded.policy_version WHERE ${legacyOwnerFenceSql}",
]) assert.ok(source.includes(fragment), "Legacy drain missing atomic fence: " + fragment);
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
              sqlite
                .prepare(
                  "UPDATE cove_runtime_config SET value='draining' WHERE key='literary_processing_owner'",
                )
                .run();
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
  const {
    processLiteraryJob,
    seedLiteraryProfiles,
    runLiteraryProfileTick,
    readLiteraryProcessingOwner,
  } = await import(pathToFileURL(path.join(dir, "literary.mjs")).href);
  const env = { DB: wrap() };
  const row = () =>
    sqlite.prepare("SELECT status,attempts FROM literary_profile_jobs WHERE id='job'").get();
  const changes = () => sqlite.prepare("SELECT total_changes() n").get().n;
  assert.equal(await readLiteraryProcessingOwner(env), "legacy", "Absent key keeps legacy active");
  assert.deepEqual(await processLiteraryJob(env, false, "prepare"), { skipped: "no_jobs" });
  sqlite
    .prepare("INSERT INTO cove_runtime_config VALUES('literary_processing_owner','draining')")
    .run();
  const before = changes();
  assert.deepEqual(await runLiteraryProfileTick(env), { skipped: "legacy_owner_fenced" });
  assert.deepEqual(await seedLiteraryProfiles(env), { seeded: 0, skipped: "legacy_owner_fenced" });
  assert.deepEqual(await processLiteraryJob(env, false, "prepare"), {
    skipped: "legacy_owner_fenced",
  });
  assert.equal(changes(), before, "Draining must have zero scheduled legacy writes");
  assert.equal(row().status, "queued");
  assert.equal(row().attempts, 0);
  sqlite.prepare("UPDATE cove_runtime_config SET value='typo'").run();
  assert.deepEqual(await processLiteraryJob(env, false, "prepare"), {
    skipped: "legacy_owner_fenced",
  });
  assert.deepEqual(await runLiteraryProfileTick(env), { skipped: "legacy_owner_fenced" });
  // Race: a worker reads legacy, then the operator fences D1 before its
  // claim statement executes. The atomic predicate must prevent a claim.
  sqlite.prepare("UPDATE cove_runtime_config SET value='legacy'").run();
  sqlite.prepare("UPDATE literary_profile_jobs SET available_at='2020-01-01'").run();
  flipAfterPreflight = true;
  assert.deepEqual(await processLiteraryJob(env, false, "prepare"), { skipped: "no_jobs" });
  assert.equal(flipAfterPreflight, false);
  assert.equal(await readLiteraryProcessingOwner(env), "draining");
  assert.equal(row().status, "queued");
  assert.equal(row().attempts, 0);
  sqlite.prepare("UPDATE cove_runtime_config SET value='isolated'").run();
  assert.deepEqual(await runLiteraryProfileTick(env), { skipped: "legacy_owner_fenced" });
  assert.deepEqual(await processLiteraryJob(env, false, "prepare"), {
    skipped: "legacy_owner_fenced",
  });
  assert.equal(row().status, "queued");
  assert.equal(row().attempts, 0);
  // Execute the same atomic D1 predicates on a real SQLite database.
  // The token-holder may have started under legacy but must not commit once
  // the operator moves canonical ownership to draining.
  const fenced = new DatabaseSync(":memory:");
  try {
    fenced.exec(
      "CREATE TABLE cove_runtime_config(key TEXT PRIMARY KEY,value TEXT);" +
        "CREATE TABLE literary_profiles(product_id TEXT PRIMARY KEY,fingerprint TEXT,status TEXT);",
    );
    const fence =
      "COALESCE((SELECT value FROM cove_runtime_config" +
      " WHERE key='literary_processing_owner'),'legacy')='legacy'";
    const seed = fenced.prepare(
      "INSERT INTO literary_profiles(product_id,fingerprint,status)" +
        " SELECT ?,?,'provisional' WHERE " +
        fence +
        " ON CONFLICT(product_id) DO UPDATE SET fingerprint=excluded.fingerprint" +
        " WHERE " +
        fence,
    );
    seed.run("fresh", "sha_a");
    assert.equal(fenced.prepare("SELECT COUNT(*) n FROM literary_profiles").get().n, 1);
    fenced
      .prepare("INSERT INTO cove_runtime_config VALUES('literary_processing_owner','draining')")
      .run();
    seed.run("late", "sha_b");
    seed.run("fresh", "sha_c");
    assert.deepEqual(
      { ...fenced.prepare("SELECT fingerprint FROM literary_profiles WHERE product_id='fresh'").get() },
      { fingerprint: "sha_a" },
    );
    assert.equal(fenced.prepare("SELECT COUNT(*) n FROM literary_profiles").get().n, 1);
    fenced.prepare("UPDATE cove_runtime_config SET value='legacy'").run();
    seed.run("fresh", "sha_d");
    assert.equal(
      fenced.prepare("SELECT fingerprint FROM literary_profiles WHERE product_id='fresh'").get()
        .fingerprint,
      "sha_d",
    );
  } finally {
    fenced.close();
  }
  console.log(
    "LITERARY_OWNER_CUTOVER_PASS legacy default, draining/isolated/unknown fence, atomic claim/late-publication race, no new primary writes",
  );
} finally {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
}
