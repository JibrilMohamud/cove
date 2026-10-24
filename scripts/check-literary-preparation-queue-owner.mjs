import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const directory = mkdtempSync(path.join(tmpdir(), "cove-literary-queue-owner-"));
const sqlite = new DatabaseSync(":memory:");
try {
  sqlite.exec("CREATE TABLE cove_runtime_config(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  await build({
    entryPoints: ["src/lib/literary-preparation-queue.server.ts"],
    outfile: path.join(directory, "queue.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { consumePreparationQueue } = await import(path.join(directory, "queue.mjs"));
  let calls = 0;
  const jobA = "a".repeat(64);
  const jobB = "b".repeat(64);
  const events = [];
  function message(jobId = jobA) {
    return {
      body: { schema: "cove.literary.prepare.v1", jobId },
      attempts: 0,
      ack() {
        events.push("ack:" + jobId);
      },
      retry(options) {
        events.push("retry:" + jobId + ":" + options.delaySeconds);
      },
    };
  }
  const DB = {
    prepare(sql) {
      assert.equal(
        sql,
        "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'",
      );
      return {
        async first() {
          return sqlite.prepare(sql).get() ?? null;
        },
      };
    },
  };
  const env = {
    DB,
    FORE_CONTENT_PROCESSOR_ENABLED: "1",
    FORE_CONTENT_PREPARE_ENABLED: "1",
    FORE_CONTENT_PROCESSOR_ROLE: "literary-prepare",
  };
  const run = async (_, id) => {
    calls++;
    assert.match(id, /^[a-f0-9]{64}$/);
    return { processed: id };
  };
  await assert.rejects(
    consumePreparationQueue(
      { messages: [message()] },
      { ...env, FORE_CONTENT_PREPARE_ENABLED: "0" },
      run,
    ),
    /preparation_queue_disabled/,
  );
  assert.equal(calls, 0);
  await consumePreparationQueue({ messages: [message()] }, env, run);
  assert.deepEqual(events.splice(0), ["retry:" + jobA + ":300"]);
  assert.equal(calls, 0, "Missing owner must never claim secondary jobs");
  sqlite
    .prepare("INSERT INTO cove_runtime_config VALUES('literary_processing_owner',?)")
    .run("legacy");
  await consumePreparationQueue({ messages: [message()] }, env, run);
  assert.deepEqual(events.splice(0), ["retry:" + jobA + ":300"]);
  sqlite.prepare("UPDATE cove_runtime_config SET value='unknown'").run();
  await consumePreparationQueue({ messages: [message()] }, env, run);
  assert.deepEqual(events.splice(0), ["retry:" + jobA + ":300"]);
  assert.equal(calls, 0);

  sqlite.prepare("UPDATE cove_runtime_config SET value='draining'").run();
  // The first completion changes canonical ownership. A second message in the
  // same batch must be deferred rather than running on the stale first check.
  await consumePreparationQueue(
    { messages: [message(jobA), message(jobB)] },
    env,
    async (jobEnv, id) => {
      await run(jobEnv, id);
      sqlite.prepare("UPDATE cove_runtime_config SET value='legacy'").run();
      return { processed: id };
    },
  );
  assert.deepEqual(events.splice(0), ["ack:" + jobA, "retry:" + jobB + ":300"]);
  assert.equal(calls, 1);

  sqlite.prepare("UPDATE cove_runtime_config SET value='isolated'").run();
  await consumePreparationQueue({ messages: [message(jobB)] }, env, run);
  assert.deepEqual(events.splice(0), ["ack:" + jobB]);
  assert.equal(calls, 2);

  await assert.rejects(
    consumePreparationQueue({ messages: [message("invalid")] }, env, run),
    /invalid_preparation_queue_message/,
  );
  assert.equal(calls, 2);
  const unavailable = {
    ...env,
    DB: {
      prepare() {
        throw Error("canonical_D1_unavailable");
      },
    },
  };
  await assert.rejects(
    consumePreparationQueue({ messages: [message()] }, unavailable, run),
    /canonical_D1_unavailable/,
  );
  assert.equal(calls, 2, "D1 failure must not acknowledge or run the wakeup");
  assert.deepEqual(events, []);
  console.log(
    "LITERARY_QUEUE_OWNER_PASS legacy/unknown/absent fail closed, 300s retries, mid-batch rollback, isolated resumption and primary D1 outage",
  );
} finally {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
}
