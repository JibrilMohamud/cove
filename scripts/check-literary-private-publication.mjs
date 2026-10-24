import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const directory = mkdtempSync(path.join(tmpdir(), "cove-private-publication-"));
const primary = new DatabaseSync(":memory:");
const content = new DatabaseSync(":memory:");
function db(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      const bound = (...values) => ({
        async first() {
          return stmt.get(...values) ?? null;
        },
        async run() {
          return stmt.run(...values);
        },
      });
      return { bind: (...values) => bound(...values), ...bound() };
    },
  };
}
try {
  primary.exec(
    "CREATE TABLE cove_runtime_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);" +
      "CREATE TABLE literary_profiles(product_id TEXT PRIMARY KEY,fingerprint TEXT,revision INTEGER,status TEXT,coverage TEXT);",
  );
  content.exec(
    readFileSync("infra/content-budget/0001_ledger.sql", "utf8") +
      readFileSync("infra/content-budget/0002_preparation_queue.sql", "utf8") +
      readFileSync("infra/content-budget/0006_isolated_inference.sql", "utf8") +
      readFileSync("infra/content-budget/0010_literary_private_publication_retries.sql", "utf8"),
  );
  await build({
    entryPoints: ["src/lib/literary-private-publication.server.ts"],
    outfile: path.join(directory, "private-pub.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { publishOnePrivateLiteraryInference } = await import(
    path.join(directory, "private-pub.mjs")
  );
  const ids = ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)];
  function fixture(n) {
    const jobId = ids[n];
    const productId = "p_" + n;
    const fingerprint = ids[(n + 1) % ids.length];
    primary
      .prepare("INSERT INTO literary_profiles VALUES(?,?,0,'provisional','metadata')")
      .run(productId, fingerprint);
    content
      .prepare(
        "INSERT INTO literary_inference_jobs(id,prepare_job_id,product_id,edition_id," +
          "source_id,source_sha256,profile_fingerprint,profile_revision,status,available_at," +
          "created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,'done',?,?,?)",
      )
      .run(
        jobId,
        ids[(n + 1) % ids.length],
        productId,
        "e_" + n,
        "s_" + n,
        ids[(n + 2) % ids.length],
        fingerprint,
        "2020-01-01",
        "2020-01-01",
        "2020-01-01",
      );
    return { jobId, productId, fingerprint };
  }
  const first = fixture(0);
  let requests = 0;
  const signerA = "x".repeat(48);
  const signerB = "y".repeat(48);
  let mode = "success";
  const service = {
    async fetch(req) {
      requests++;
      assert.equal(new URL(req.url).pathname, "/v1/operator/publish");
      assert.equal(req.headers.get("x-cove-literary-publish-token"), signerA);
      assert.equal(req.headers.get("x-cove-literary-backend-token"), signerB);
      const { jobId } = await req.json();
      const row = content
        .prepare("SELECT product_id FROM literary_inference_jobs WHERE id=?")
        .get(jobId);
      if (mode === "outage") return Response.json({ error: "busy" }, { status: 503 });
      if (mode === "false_ack") return Response.json({ published: row.product_id });
      if (mode === "held") return Response.json({ skipped: "rights_source_or_version_changed" });
      if (mode === "duplicate")
        return Response.json({ skipped: "rights_source_or_version_changed" });
      primary
        .prepare(
          "UPDATE literary_profiles SET status='analyzed',coverage='isolated_samples'," +
            "revision=revision+1 WHERE product_id=?",
        )
        .run(row.product_id);
      return Response.json({ published: row.product_id });
    },
  };
  const env = {
    DB: db(primary),
    CONTENT_DB: db(content),
    FORE_CONTENT_PROCESSOR_ENABLED: "1",
    FORE_CONTENT_PREPARE_ENABLED: "1",
    FORE_CONTENT_INFERENCE_ENABLED: "1",
    FORE_CONTENT_PROCESSOR_ROLE: "literary-infer",
    FORE_LITERARY_AUTOPUBLISH_ENABLED: "1",
    FORE_LITERARY_INFERENCE_PUBLISH_TOKEN: signerA,
    FORE_LITERARY_INFERENCE_BACKEND_TOKEN: signerB,
    LITERARY_PUBLISHER: service,
  };
  assert.deepEqual(
    await publishOnePrivateLiteraryInference({
      ...env,
      FORE_LITERARY_AUTOPUBLISH_ENABLED: "0",
    }),
    { skipped: "private_publication_disabled" },
  );
  assert.deepEqual(
    await publishOnePrivateLiteraryInference({ ...env, LITERARY_PUBLISHER: undefined }),
    { skipped: "private_publisher_not_bound" },
  );
  assert.deepEqual(await publishOnePrivateLiteraryInference(env), {
    skipped: "canonical_owner_not_isolated",
  });
  primary
    .prepare("INSERT INTO cove_runtime_config VALUES('literary_processing_owner','draining')")
    .run();
  assert.equal(
    (await publishOnePrivateLiteraryInference(env)).skipped,
    "canonical_owner_not_isolated",
  );
  assert.equal(requests, 0);
  assert.equal(
    content
      .prepare("SELECT publication_state FROM literary_inference_jobs WHERE id=?")
      .get(first.jobId).publication_state,
    "pending",
  );
  primary.prepare("UPDATE cove_runtime_config SET value='isolated'").run();
  assert.deepEqual(await publishOnePrivateLiteraryInference(env), { published: first.jobId });
  assert.equal(requests, 1);
  assert.equal(
    primary
      .prepare("SELECT revision FROM literary_profiles WHERE product_id=?")
      .get(first.productId).revision,
    1,
  );
  assert.deepEqual(await publishOnePrivateLiteraryInference(env), {
    skipped: "no_completed_inference",
  });

  // A lost secondary ACK after a canonical success is replayable. The
  // publisher reports a revision conflict; authoritative primary evidence
  // proves it was this exact content-addressed inference.
  content
    .prepare(
      "UPDATE literary_inference_jobs SET publication_state='pending'," +
        "publication_available_at='2020-01-01' WHERE id=?",
    )
    .run(first.jobId);
  mode = "duplicate";
  assert.deepEqual(await publishOnePrivateLiteraryInference(env), { published: first.jobId });
  assert.equal(
    primary
      .prepare("SELECT revision FROM literary_profiles WHERE product_id=?")
      .get(first.productId).revision,
    1,
  );

  const second = fixture(1);
  mode = "held";
  assert.deepEqual(await publishOnePrivateLiteraryInference(env), {
    held: second.jobId,
    reason: "rights_source_or_version_changed",
  });
  assert.equal(
    content
      .prepare("SELECT publication_state FROM literary_inference_jobs WHERE id=?")
      .get(second.jobId).publication_state,
    "held",
  );

  const third = fixture(2);
  mode = "outage";
  const retry = await publishOnePrivateLiteraryInference(env);
  assert.equal(retry.deferred, third.jobId);
  assert.match(retry.reason, /private_publisher_status_503/);
  assert.equal(
    content
      .prepare("SELECT publication_state FROM literary_inference_jobs WHERE id=?")
      .get(third.jobId).publication_state,
    "pending",
  );
  assert.equal((await publishOnePrivateLiteraryInference(env)).skipped, "no_completed_inference");
  content
    .prepare("UPDATE literary_inference_jobs SET publication_available_at='2020-01-01' WHERE id=?")
    .run(third.jobId);
  mode = "success";
  assert.deepEqual(await publishOnePrivateLiteraryInference(env), { published: third.jobId });

  const fourth = fixture(3);
  const raceEnv = {
    ...env,
    CONTENT_DB: {
      prepare(sql) {
        const statement = env.CONTENT_DB.prepare(sql);
        if (!sql.startsWith("UPDATE literary_inference_jobs SET publication_state='running'"))
          return statement;
        return {
          bind(...values) {
            const bound = statement.bind(...values);
            return {
              async first() {
                const row = await bound.first();
                primary.prepare("UPDATE cove_runtime_config SET value='legacy'").run();
                return row;
              },
            };
          },
        };
      },
    },
  };
  const before = requests;
  assert.deepEqual(await publishOnePrivateLiteraryInference(raceEnv), {
    skipped: "canonical_owner_changed_after_claim",
  });
  assert.equal(requests, before);
  primary.prepare("UPDATE cove_runtime_config SET value='isolated'").run();
  content
    .prepare("UPDATE literary_inference_jobs SET publication_lease_until='2020-01-01' WHERE id=?")
    .run(fourth.jobId);
  assert.deepEqual(await publishOnePrivateLiteraryInference(env), { published: fourth.jobId });
  const falseAck = fixture(4);
  mode = "false_ack";
  const unverified = await publishOnePrivateLiteraryInference(env);
  assert.equal(unverified.deferred, falseAck.jobId);
  assert.match(unverified.reason, /private_publisher_ack_unverified/);
  assert.equal(
    primary
      .prepare("SELECT revision FROM literary_profiles WHERE product_id=?")
      .get(falseAck.productId).revision,
    0,
  );
  content
    .prepare("UPDATE literary_inference_jobs SET publication_available_at='2020-01-01' WHERE id=?")
    .run(falseAck.jobId);
  mode = "success";
  assert.deepEqual(await publishOnePrivateLiteraryInference(env), { published: falseAck.jobId });
  assert.equal(
    primary.prepare("SELECT COUNT(*) n FROM literary_profiles WHERE status='analyzed'").get().n,
    4,
  );
  assert.deepEqual(
    content
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM literary_inference_jobs " +
          "INDEXED BY idx_literary_inference_publication_due WHERE status='done' " +
          "AND publication_state='pending' ORDER BY publication_available_at,id LIMIT 1",
      )
      .all()
      .some((row) => String(row.detail).includes("idx_literary_inference_publication_due")),
    true,
  );
  console.log(
    "LITERARY_PRIVATE_PUBLICATION_PASS dual SQLite domains, canonical ACK verification, legacy/drain denial, owner rollback, bounded claims, lost ACK replay, rights hold and transport retry",
  );
} finally {
  primary.close();
  content.close();
  rmSync(directory, { recursive: true, force: true });
}
