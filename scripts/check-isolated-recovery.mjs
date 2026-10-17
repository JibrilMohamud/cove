import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

// Synthetic data only. This executes a physical SQLite restore and application
// probes; it does not claim to exercise D1 provider recovery or production RPO.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cove-recovery-drill-"));
try {
  const source = path.join(root, "source"),
    restored = path.join(root, "restored");
  await fs.mkdir(source);
  await fs.cp("drizzle", path.join(source, "drizzle"), { recursive: true });
  await build({
    entryPoints: {
      api: "src/features/fore/api.server.ts",
      ops: "src/features/fore/operations.server.ts",
    },
    outdir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(root, "api.mjs"));
  const ops = await import(path.join(root, "ops.mjs"));
  const env = localBindings(source);
  const at = new Date().toISOString();
  // Seed a heavy reader in one atomic transaction, not thousands of HTTP writes.
  const sourceDb = new DatabaseSync(path.join(source, ".sites-runtime/fore.sqlite"));
  sourceDb.exec("BEGIN");
  const insert = sourceDb.prepare(
    "INSERT INTO annotations(id,user_id,book_id,book_title,author,quote,cfi,chapter,color,note,created_at,updated_at) VALUES(?,?,'1342','Pride and Prejudice','Austen',?,'epubcfi(/6/2!)','Chapter','yellow',?,?,?)",
  );
  for (let i = 0; i < 5000; i++)
    insert.run(
      `note-${String(i).padStart(5, "0")}`,
      "heavy-reader",
      `Quote ${i}`,
      `Synthetic private note ${i}`,
      at,
      at,
    );
  insert.run("bob-only", "other-reader", "Other passage", "Other private note", at, at);
  sourceDb.exec("COMMIT");
  const snapshotAt = new Date().toISOString(),
    snapshot = path.join(root, "snapshot.sqlite");
  await backup(sourceDb, snapshot);
  const checksum = createHash("sha256")
    .update(await fs.readFile(snapshot))
    .digest("hex");
  const started = performance.now();
  await fs.mkdir(path.join(restored, ".sites-runtime"), { recursive: true });
  await fs.cp(path.join(source, "drizzle"), path.join(restored, "drizzle"), { recursive: true });
  await fs.copyFile(snapshot, path.join(restored, ".sites-runtime/fore.sqlite"));
  const restoredDb = new DatabaseSync(path.join(restored, ".sites-runtime/fore.sqlite"));
  assert.equal(restoredDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(restoredDb.prepare("PRAGMA foreign_key_check").all(), []);
  const recovered = localBindings(restored);
  const call = async (route, user = "heavy-reader") => {
    const response = await handleCoveApi(
      new Request("https://isolated.test/api/fore" + route, {
        headers: {
          "oai-authenticated-user-id": user,
          "oai-authenticated-user-email": user + "@example.test",
        },
      }),
      recovered,
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await call("/account");
  assert.equal(initial.annotations.length, 100, "account payload stays bounded after restore");
  const times = [],
    ids = new Set();
  let offset = 0;
  do {
    const before = performance.now();
    const page = await call(`/account/collection?kind=annotations&limit=100&offset=${offset}`);
    times.push(performance.now() - before);
    assert.ok(page.items.length <= 100);
    for (const item of page.items) {
      assert.ok(!ids.has(item.id));
      ids.add(item.id);
    }
    offset = page.hasMore ? page.nextOffset : null;
  } while (offset != null);
  assert.equal(ids.size, 5000);
  const other = await call("/account/collection?kind=annotations", "other-reader");
  assert.deepEqual(
    other.items.map((item) => item.id),
    ["bob-only"],
  );
  const duration = Math.ceil((performance.now() - started) / 1000);
  const evidence = {
    environment: "isolated-local-synthetic",
    rowsRecovered: ids.size,
    integrity: "ok",
    foreignKeyViolations: 0,
    pages: times.length,
    pageP95Ms: Math.round(times.sort((a, b) => a - b)[Math.floor((times.length - 1) * 0.95)]),
    restoreAndProbeSeconds: duration,
    checksumSha256: checksum,
    productionRpoVerified: false,
  };
  const raw = {
    serviceKey: "primary-database",
    provider: "isolated-sqlite-drill",
    providerBackupId: "synthetic-snapshot",
    snapshotAt,
    sizeBytes: (await fs.stat(snapshot)).size,
    checksumSha256: checksum,
    status: "verified",
    verification: { integrityCheck: "ok", checksumVerified: true, scope: "synthetic-local-only" },
  };
  const artifact = await ops.registerBackupArtifact(recovered.DB, raw);
  assert.equal(
    (await ops.registerBackupArtifact(recovered.DB, raw)).id,
    artifact.id,
    "backup retry preserves usable artifact identity",
  );
  await ops.recordRestoreDrill(recovered.DB, "drill-runner", {
    serviceKey: "primary-database",
    backupArtifactId: artifact.id,
    environment: "isolated-local-synthetic",
    startedAt: snapshotAt,
    finishedAt: new Date().toISOString(),
    restoreDurationSeconds: duration,
    dataLossWindowSeconds: 0,
    integrityCheckStatus: "passed",
    applicationProbeStatus: "passed",
    status: "passed",
    evidence,
  });
  const job = await ops.enqueueOpsJob(recovered.DB, {
    queueKey: "search-index",
    jobType: "synthetic-drill",
    dedupeKey: "recover-once",
  });
  assert.equal(
    (
      await ops.enqueueOpsJob(recovered.DB, {
        queueKey: "search-index",
        jobType: "synthetic-drill",
        dedupeKey: "recover-once",
      })
    ).id,
    job.id,
  );
  assert.equal((await ops.leaseOpsJobs(recovered.DB, "worker-old", "search-index")).jobs.length, 1);
  await recovered.DB.prepare("UPDATE ops_jobs SET lease_until=? WHERE id=?")
    .bind("2000-01-01T00:00:00.000Z", job.id)
    .run();
  assert.equal((await ops.leaseOpsJobs(recovered.DB, "worker-new", "search-index")).jobs.length, 1);
  await assert.rejects(
    ops.finishOpsJob(recovered.DB, { jobId: job.id, workerId: "worker-old", success: true }),
    /lease/,
  );
  assert.equal(
    (await ops.finishOpsJob(recovered.DB, { jobId: job.id, workerId: "worker-new", success: true }))
      .status,
    "completed",
  );
  evidence.interruptedQueueRecovered = true;
  console.log("COVE_ISOLATED_RECOVERY " + JSON.stringify(evidence));
  sourceDb.close();
  restoredDb.close();
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
