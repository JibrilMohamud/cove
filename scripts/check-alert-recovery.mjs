import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

// No external webhook is called. Exercise real SQL and delivery code with a
// controlled receiver, including overlapping workers and interrupted attempts.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cove-alert-recovery-"));
const originalFetch = globalThis.fetch;
try {
  await fs.cp("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/operations.server.ts"],
    outfile: path.join(root, "ops.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { deliverOperationalAlerts } = await import(path.join(root, "ops.mjs"));
  const { DB: db } = localBindings(root);
  const at = new Date().toISOString();
  const expired = new Date(Date.now() - 120_000).toISOString();
  let next = 0;
  async function seed({
    status = "pending",
    attempts = 0,
    max = 3,
    lease = null,
    metadata = "{}",
  } = {}) {
    const id = `drill-${++next}`;
    await db
      .prepare(
        "INSERT INTO ops_incidents(id,dedupe_key,severity,status,title,summary,opened_at,metadata_json) VALUES(?,?,'warning','open','Synthetic drill','No production recipient',?,?)",
      )
      .bind(id, id, at, metadata)
      .run();
    await db
      .prepare(
        "INSERT INTO ops_alert_deliveries(id,incident_id,event_type,notification_target,status,attempts,max_attempts,available_at,leased_at,created_at,updated_at) VALUES(?,?,'opened','isolated-test',?,?,?,?,?,?,?)",
      )
      .bind(id, id, status, attempts, max, expired, lease, at, at)
      .run();
    return id;
  }
  const row = (id) => db.prepare("SELECT * FROM ops_alert_deliveries WHERE id=?").bind(id).first();
  const run = () =>
    deliverOperationalAlerts(db, "https://alerts.example.test/receiver", "fixture-token");
  let calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(options);
    return new Response(null, { status: 204 });
  };
  const lost = await seed({ status: "leased", attempts: 1, lease: expired });
  assert.equal((await run()).sent, 1);
  assert.equal((await row(lost)).attempts, 2);
  assert.equal(calls[0].headers["idempotency-key"], `cove-alert:${lost}`);
  assert.equal(calls[0].headers.authorization, "Bearer fixture-token");
  assert.ok(calls[0].signal instanceof AbortSignal, "transport has a deadline");
  assert.equal((await run()).processed, 0, "sent delivery is not resent");

  const exhausted = await seed({ status: "leased", attempts: 3, lease: expired });
  const before = calls.length;
  await run();
  assert.equal((await row(exhausted)).status, "dead");
  assert.equal(calls.length, before, "exhausted attempts never call receiver");
  const active = await seed({ status: "leased", attempts: 1, lease: new Date().toISOString() });
  await run();
  assert.equal((await row(active)).status, "leased", "fresh worker retains lease");
  await db.prepare("UPDATE ops_alert_deliveries SET status='sent' WHERE id=?").bind(active).run();

  const transient = await seed();
  globalThis.fetch = async () => new Response(null, { status: 503 });
  assert.equal((await run()).retried, 1);
  assert.equal((await row(transient)).status, "retry");
  assert.equal((await run()).processed, 0, "backoff cannot be bypassed");
  await db
    .prepare("UPDATE ops_alert_deliveries SET available_at=? WHERE id=?")
    .bind(expired, transient)
    .run();
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal((await run()).sent, 1);

  const corrupt = await seed({ metadata: "{bad" });
  assert.equal((await run()).retried, 1, "bad payload releases lease through retry path");
  await db.prepare("UPDATE ops_alert_deliveries SET status='dead' WHERE id=?").bind(corrupt).run();

  const overlap = await seed();
  let release, entered;
  const receiving = new Promise((resolve) => {
    entered = resolve;
  });
  globalThis.fetch = async () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const first = run();
  await receiving;
  assert.equal((await run()).processed, 0, "another worker cannot take a live lease");
  await db
    .prepare("UPDATE ops_alert_deliveries SET leased_at=? WHERE id=?")
    .bind(expired, overlap)
    .run();
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal((await run()).sent, 1, "interrupted lease can be reclaimed");
  release(new Response(null, { status: 503 }));
  assert.equal((await first).retried, 0, "stale completion cannot clobber new success");
  assert.equal((await row(overlap)).status, "sent");

  // AbortSignal.timeout is provided by the runtime; simulate its rejection
  // without waiting ten seconds in every CI job.
  const timeout = await seed();
  globalThis.fetch = async (_url, options) => {
    assert.ok(options.signal);
    throw new DOMException("Deadline", "TimeoutError");
  };
  assert.equal((await run()).retried, 1);
  assert.equal((await row(timeout)).status, "retry");
  await assert.rejects(deliverOperationalAlerts(db, "https://127.0.0.1/receiver"), /private|local/);
  console.log(
    "PASS: real alert SQL recovers interrupted leases, respects attempts/backoff, bounds transport, preserves idempotency and fences stale workers; receiver is isolated.",
  );
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(root, { recursive: true, force: true });
}
