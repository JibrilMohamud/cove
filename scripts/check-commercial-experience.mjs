import os from "node:os";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localBindings } from "./local-api.mjs";
import { loadAccountOwnerTestClient } from "./test-private-account-client.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-commercial-"));
fs.cpSync("drizzle", path.join(scratch, "drizzle"), { recursive: true });
await build({
  entryPoints: [
    "src/features/fore/api.server.ts",
    "src/features/fore/customer-support.server.ts",
    "src/features/fore/public-status.server.ts",
    "src/features/fore/api-transport.ts",
    "src/features/fore/account-management.server.ts",
    "src/persistence-backend.worker.ts",
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: scratch,
  entryNames: "[name]",
  outExtension: { ".js": ".mjs" },
  logLevel: "silent",
});
const { handleCoveApi } = await import(path.join(scratch, "api.server.mjs"));
const support = await import(path.join(scratch, "customer-support.server.mjs"));
const status = await import(path.join(scratch, "public-status.server.mjs"));
const accountOwnerClient = await loadAccountOwnerTestClient(scratch);
const { processAccountDeletionQueue } = accountOwnerClient;
const { requestCove, CoveRequestError } = await import(path.join(scratch, "api-transport.mjs"));
const env = localBindings(scratch);
const { default: worker } = await import(path.join(scratch, "persistence-backend.worker.mjs"));
async function req(route, method = "GET", body, user = "reader-a", aal = "aal1") {
  const headers = { "Content-Type": "application/json", Origin: "https://fore.test" };
  if (user) {
    headers["oai-authenticated-user-id"] = user;
    headers["oai-authenticated-user-email"] = `${user}@example.test`;
    headers["oai-authentication-assurance-level"] = aal;
  }
  const response = await handleCoveApi(
    new Request(`https://fore.test/api/fore${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: response.status, data: await response.json() };
}
const payload = () => ({
  requestKey: randomUUID(),
  category: "download",
  subject: "Missing downloaded book",
  message: "Please help me recover my downloaded book.",
  requestId: "request-test",
});
assert.equal((await req("/support/tickets", "GET", undefined, null)).status, 401);
const creation = payload();
const created = await req("/support/tickets", "POST", creation);
assert.equal(created.status, 201);
const id = created.data.ticket.id;
assert.equal(created.data.ticket.version, 2);
assert.equal((await req("/support/tickets", "POST", creation)).data.ticket.id, id);
assert.equal(
  (await req("/support/tickets", "POST", { ...creation, subject: "Different subject" })).status,
  409,
);
assert.equal(
  (await req("/support/tickets", "POST", { ...payload(), userId: "reader-b" })).status,
  400,
);
assert.equal(
  (await req("/support/tickets", "POST", { ...payload(), orderId: "foreign-order" })).status,
  404,
);
assert.equal((await req(`/support/tickets/${id}`, "GET", undefined, "reader-b")).status, 404);
assert.equal(
  (
    await req(
      `/support/tickets/${id}`,
      "POST",
      { requestKey: randomUUID(), expectedVersion: 2, message: "Attempt" },
      "reader-b",
    )
  ).status,
  404,
);
assert.equal(
  (
    await req(`/support/tickets/${id}`, "POST", {
      requestKey: randomUUID(),
      expectedVersion: 2,
      message: "Attempt",
      status: "closed",
    })
  ).status,
  403,
);
assert.equal((await req("/admin/support/tickets")).status, 403);
assert.equal((await req("/admin/operations/public-notices", "POST", {})).status, 403);

// Direct business functions isolate race, replay and read-marker semantics from rate limits.
let thread = await support.replyCustomerSupport(env.DB, id, "staff-a", true, {
  requestKey: randomUUID(),
  expectedVersion: 2,
  message: "First staff reply",
});
assert.equal(thread.ticket.version, 3);
assert.equal((await support.supportInbox(env.DB, "reader-a")).tickets[0].unread, true);
await support.replyCustomerSupport(env.DB, id, "staff-a", true, {
  requestKey: randomUUID(),
  expectedVersion: 3,
  message: "A newer staff reply",
});
await support.markSupportRead(env.DB, id, "reader-a", { viewedVersion: 3 });
assert.equal((await support.supportInbox(env.DB, "reader-a")).tickets[0].unread, true);
await support.markSupportRead(env.DB, id, "reader-a", { viewedVersion: 4 });
assert.equal((await support.supportInbox(env.DB, "reader-a")).tickets[0].unread, false);
await assert.rejects(
  support.replyCustomerSupport(env.DB, id, "reader-a", false, {
    requestKey: randomUUID(),
    expectedVersion: 3,
    message: "Stale reply",
  }),
  (e) => e.status === 409,
);
const reply = {
  requestKey: randomUUID(),
  expectedVersion: 4,
  message: "Thank you. I still need help.",
};
thread = await support.replyCustomerSupport(env.DB, id, "reader-a", false, reply);
assert.equal(thread.ticket.status, "open");
assert.equal(
  (await support.replyCustomerSupport(env.DB, id, "reader-a", false, reply)).ticket.version,
  5,
);
await assert.rejects(
  support.replyCustomerSupport(env.DB, id, "reader-a", false, {
    ...reply,
    message: "Changed retry",
  }),
  (e) => e.status === 409,
);
thread = await support.replyCustomerSupport(env.DB, id, "staff-a", true, {
  requestKey: randomUUID(),
  expectedVersion: 5,
  message: "This request is now closed.",
  status: "closed",
});
await assert.rejects(
  support.replyCustomerSupport(env.DB, id, "reader-a", false, {
    requestKey: randomUUID(),
    expectedVersion: 6,
    message: "Cannot reopen a closed request",
  }),
  (e) => e.status === 409,
);

for (let i = 0; i < 10; i++) await support.createCustomerSupport(env.DB, "reader-a", payload());
await assert.rejects(
  support.createCustomerSupport(env.DB, "reader-a", payload()),
  (e) => e.status === 409,
);
await assert.rejects(
  support.replyCustomerSupport(env.DB, id, "staff-a", true, {
    requestKey: randomUUID(),
    expectedVersion: 6,
    message: "Reopening",
    status: "open",
  }),
  (e) => e.status === 409,
);
assert.equal((await support.supportThread(env.DB, id, "reader-a")).ticket.version, 6);
const ownedExport = await support.exportCustomerSupport(env.DB, "reader-a");
assert.equal(ownedExport.tickets.length, 11);
assert.equal(JSON.stringify(ownedExport).includes("sender_id"), false);
assert.equal((await support.exportCustomerSupport(env.DB, "reader-b")).tickets.length, 0);
const apiExport = await req("/export");
assert.equal(apiExport.status, 200);
assert.equal(apiExport.data.version, 4);
assert.equal(apiExport.data.support.tickets.length, 11);

// Long conversations remain readable through bounded pages.
for (let i = 0; i < 101; i++) {
  thread = await support.replyCustomerSupport(env.DB, id, "staff-a", true, {
    requestKey: randomUUID(),
    expectedVersion: thread.ticket.version,
    message: `Archive message ${i}`,
    status: "closed",
  });
}
const current = await support.supportThread(env.DB, id, "reader-a");
assert.equal(current.messages.length, 100);
assert.ok(current.nextBefore);
const earlier = await support.supportThread(env.DB, id, "reader-a", current.nextBefore);
assert.equal(earlier.messages.length, 6);
assert.equal(new Set([...current.messages, ...earlier.messages].map((x) => x.id)).size, 106);
assert.equal(current.messages.at(-1).body, "Archive message 100");
await assert.rejects(
  support.supportThread(env.DB, id, "reader-a", "invalid-cursor"),
  (e) => e.status === 404,
);

assert.equal((await req("/service-status", "GET", undefined, null)).data.overall, "unknown");
const snapshot = await status.refreshPublicStatus(env);
assert.equal(snapshot.components.find((x) => x.id === "biosync").status, "limited");
assert.equal((await status.publicServiceStatus(env)).stale, false);
const at = new Date().toISOString();
await env.DB.prepare("INSERT INTO staff_principals(user_id,created_at,updated_at) VALUES(?,?,?)")
  .bind("staff-a", at, at)
  .run();
await env.DB.prepare(
  "INSERT INTO staff_principal_roles(user_id,role_id,granted_at) VALUES(?,'role_customer_support',?)",
)
  .bind("staff-a", at)
  .run();
assert.equal((await req("/admin/support/tickets", "GET", undefined, "staff-a")).status, 403);
assert.equal(
  (await req("/admin/support/tickets", "GET", undefined, "staff-a", "aal2")).status,
  200,
);
assert.equal(
  (await req(`/admin/support/tickets/${id}`, "GET", undefined, "staff-a", "aal2")).data.messages
    .length,
  100,
);
assert.equal(
  (await req("/admin/operations/public-notices", "GET", undefined, "staff-a", "aal2")).status,
  403,
);
await env.DB.prepare(
  "INSERT INTO staff_principal_roles(user_id,role_id,granted_at) VALUES(?,'role_operations_engineer',?)",
)
  .bind("staff-a", at)
  .run();
await env.DB.prepare(
  "INSERT INTO support_cases(id,user_id,category,subject,created_by_staff_user_id,created_at,updated_at) VALUES('internal-case','reader-a','account','Confidential internal case','staff-a',?,?)",
)
  .bind(at, at)
  .run();
await env.DB.prepare(
  "INSERT INTO support_case_events(id,case_id,event_type,staff_user_id,note,created_at) VALUES('internal-event','internal-case','note','staff-a','PRIVATE_NOTE_SENTINEL',?)",
)
  .bind(at)
  .run();
assert.equal(
  JSON.stringify((await req(`/support/tickets/${id}`)).data).includes("PRIVATE_NOTE_SENTINEL"),
  false,
);
assert.equal(
  JSON.stringify((await req("/export")).data.support).includes("PRIVATE_NOTE_SENTINEL"),
  false,
);
const notice = {
  id: randomUUID(),
  title: "Download interruption",
  body: "We are investigating a download interruption.",
  status: "investigating",
  severity: "outage",
  components: ["downloads"],
  publish: true,
};
assert.equal(
  (await req("/admin/operations/public-notices", "POST", notice, "staff-a", "aal2")).data.version,
  1,
);
assert.equal((await status.publishServiceNotice(env, "staff-a", notice)).version, 1);
await assert.rejects(
  status.publishServiceNotice(env, "staff-a", { ...notice, body: "Different retry" }),
  (e) => e.status === 409,
);
let publicStatus = await status.publicServiceStatus(env);
assert.equal(publicStatus.components.find((x) => x.id === "downloads").status, "unavailable");
assert.equal(JSON.stringify(publicStatus).includes("staff-a"), false);
assert.equal(JSON.stringify(publicStatus).includes("creation_sha256"), false);
await env.DB.prepare("UPDATE cove_runtime_config SET value=? WHERE key='public_service_status'")
  .bind(JSON.stringify({ ...snapshot, checkedAt: "2000-01-01T00:00:00Z" }))
  .run();
publicStatus = await status.publicServiceStatus(env);
assert.equal(publicStatus.stale, true);
assert.equal(publicStatus.components.find((x) => x.id === "downloads").status, "unavailable");
assert.equal(publicStatus.components.find((x) => x.id === "storefront").status, "unknown");
await status.publishServiceNotice(env, "staff-a", {
  ...notice,
  expectedVersion: 1,
  status: "resolved",
});
await assert.rejects(
  status.publishServiceNotice(env, "staff-a", {
    ...notice,
    expectedVersion: 1,
    status: "monitoring",
  }),
  (e) => e.status === 409,
);
assert.equal(
  (await env.DB.prepare("SELECT count(*) n FROM public_service_notice_history").first()).n,
  2,
);
await assert.rejects(
  env.DB.prepare("UPDATE public_service_notice_history SET body='tampered'").run(),
  /immutable/,
);

// The actual account erasure worker cascades through every private conversation.
await env.DB.prepare(
  "INSERT INTO account_deletion_requests(id,user_id,status,requested_at,execute_after,confirmation_hash,created_at,updated_at) VALUES(?,?,'queued',?,?,?,?,?)",
)
  .bind(randomUUID(), "reader-a", at, "2000-01-01T00:00:00Z", "test-hash", at, at)
  .run();
assert.equal((await processAccountDeletionQueue(env)).completed, 1);
assert.equal(
  (await env.DB.prepare("SELECT count(*) n FROM customer_support_messages").first()).n,
  0,
);
assert.equal((await env.DB.prepare("PRAGMA foreign_key_check").all()).results.length, 0);

// A failure in ingestion scheduling cannot suppress a successful health check.
await env.DB.prepare("DELETE FROM cove_runtime_config WHERE key='public_service_status'").run();
const scheduledTasks = [];
const brokenIngestion = {
  ...env,
  DB: {
    ...env.DB,
    prepare(sql) {
      if (sql.includes("SUM(CASE WHEN kind='align'"))
        throw new Error("Simulated ingestion scheduling failure");
      return env.DB.prepare(sql);
    },
  },
};
await worker.scheduled({ cron: "*/5 * * * *" }, brokenIngestion, {
  waitUntil(task) {
    scheduledTasks.push(task);
  },
});
await Promise.allSettled(scheduledTasks);
assert.ok(
  await env.DB.prepare(
    "SELECT value FROM cove_runtime_config WHERE key='public_service_status'",
  ).first(),
);

const originalFetch = globalThis.fetch;
try {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('{"error":"busy"}', { status: 503, headers: { "retry-after": "0" } })
      : Response.json({ ok: true });
  };
  assert.deepEqual(await requestCove("/test"), { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{"error":"busy"}', {
      status: 503,
      headers: { "x-fore-request-id": "trace-safe", "retry-after": "60" },
    });
  };
  await assert.rejects(
    requestCove("/test", "POST", {}),
    (e) => e instanceof CoveRequestError && e.mutationUncertain && e.requestId === "trace-safe",
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(requestCove("/test"), (e) => e.retryAfterSeconds === 60);
  assert.equal(calls, 1);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: "Sign in" }, { status: 401 });
  };
  await assert.rejects(requestCove("/test"), (e) => e.status === 401 && !e.retryable);
  assert.equal(calls, 1);
  globalThis.fetch = async () => {
    throw new TypeError("network");
  };
  await assert.rejects(
    requestCove("/test", "POST", {}),
    (e) => e.mutationUncertain && e.status === 0,
  );
  globalThis.fetch = async () => new Response("invalid json");
  await assert.rejects(
    requestCove("/test", "GET", undefined, { retryReads: false }),
    (e) => e.status === 502,
  );
  globalThis.fetch = (_url, options) =>
    new Promise((_resolve, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      ),
    );
  await assert.rejects(
    requestCove("/test", "POST", {}, { timeoutMs: 5 }),
    (e) => e.mutationUncertain,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    requestCove("/test", "GET", undefined, { signal: cancelled.signal }),
    (e) => e.name === "AbortError",
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "PASS: support ownership, role gates, idempotent creation/replies, version conflicts, unread races, limits, pagination, export/erasure, truthful public status, notice audit and request recovery.",
);
accountOwnerClient.close();
fs.rmSync(scratch, { recursive: true, force: true });
