/** Private, leased QA execution of the seven CLOSED scheduled operations.
 * No SQL, environment, actor identity or arbitrary job name crosses this RPC.
 * The backend has no D1; operational writes execute on the owner. Existing
 * canonical legal/commerce fences and typed owner commands remain mandatory.
 * This does not enroll production or establish rightsholder authority.
 */
import type { CatalogDB } from "../features/fore/catalog-model.server";
import type { BackendEnv } from "../persistence-backend.worker";
import { bindPublicationOwner } from "./publication-owner-routing.server";
import { makeStageLegalWriterLock } from "./legal-primary-write-lock";
import { commerceRestrictedCanonicalD1 } from "./commerce-d1-write-fence";
import { assertCronSettled } from "../lib/cron-result-guard";

export const QA_SCHEDULE_ROUTE = "/qa/private-backend-scheduled-tick";
export const QA_SCHEDULE_SCHEMA = "cove.qa.owner-scheduled-tick.v1";
export const OWNER_SCHEDULES = Object.freeze([
  "* * * * *",
  "*/5 * * * *",
  "*/10 * * * *",
  "7-57/10 * * * *",
  "23 * * * *",
  "17 3 * * *",
  "41 4 * * *",
]);
// Exact paid fixtures already enrolled by the canonical owner. The second
// is the isolated Cove QA account used by protected hosted campaigns.
const QA_PRIMARIES = new Set([
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
  "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3",
]);
const NO_STORE = { "cache-control": "no-store" };
type Port = { fetch(request: Request): Promise<Response> };
type Env = Partial<BackendEnv> & {
  COVE_QA_SCHEDULE_OWNER_ENABLED?: string;
  COVE_RIGHTS_OWNER_PRIMARY_ID?: string;
  COVE_RIGHTS_OWNER_ENABLED?: string;
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT?: string;
  COVE_RIGHTS_OWNER_SECRET?: string;
  PRIMARY_DB?: CatalogDB;
};
type Sql = {
  exec<T = Record<string, unknown>>(sql: string, ...args: unknown[]): { toArray(): T[] };
};
type Storage = { sql: Sql; transactionSync<T>(fn: () => T): T };
type Command = { schema: typeof QA_SCHEDULE_SCHEMA; cron: string; slot: number };

function enrolled(env: Env) {
  const expiry = Number(env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT),
    at = Date.now();
  return (
    env.COVE_QA_SCHEDULE_OWNER_ENABLED === "1" &&
    env.FORE_ENVIRONMENT === "staging" &&
    env.COVE_SSR_STAGING === "1" &&
    env.COVE_RIGHTS_OWNER_ENABLED === "1" &&
    QA_PRIMARIES.has(env.COVE_RIGHTS_OWNER_PRIMARY_ID || "") &&
    env.COVE_LEGAL_WRITER_PRIMARY_ID === env.COVE_RIGHTS_OWNER_PRIMARY_ID &&
    env.COVE_PUBLICATION_COMMAND_TERRITORY === "US" &&
    env.COVE_PUBLICATION_COMMAND_CURRENCY === "USD" &&
    /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET || "") &&
    Number.isSafeInteger(expiry) &&
    expiry > at &&
    expiry <= at + 15 * 60_000 &&
    env.STRIPE_LIVEMODE !== "true" &&
    (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY.startsWith("sk_test_")) &&
    [undefined, "0"].includes(env.COVE_OWNER_EXCLUSIVE_WRITER_FENCE) &&
    [undefined, "0"].includes(env.COVE_COMMERCE_OWNER_D1_FENCE)
  );
}
function checkedCommand(raw: unknown): Command {
  const input = raw as Command;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "cron,schema,slot" ||
    input.schema !== QA_SCHEDULE_SCHEMA ||
    !OWNER_SCHEDULES.includes(input.cron) ||
    !Number.isSafeInteger(input.slot) ||
    Math.abs(input.slot - Math.floor(Date.now() / 60_000)) > 2
  )
    throw Error("qa_scheduled_command_invalid");
  return input;
}
function checkedReceipt(raw: unknown, command: Command) {
  const result = raw as Command & { completed: boolean; ownerFirst: boolean; taskCount: number };
  if (
    !result ||
    typeof result !== "object" ||
    Object.keys(result).sort().join(",") !== "completed,cron,ownerFirst,schema,slot,taskCount" ||
    result.schema !== QA_SCHEDULE_SCHEMA ||
    result.cron !== command.cron ||
    result.slot !== command.slot ||
    result.completed !== true ||
    result.ownerFirst !== true ||
    !Number.isSafeInteger(result.taskCount) ||
    result.taskCount < 1 ||
    result.taskCount > 4
  )
    throw Error("qa_scheduled_owner_receipt_invalid");
  return result;
}

export async function dispatchQaOwnerScheduledTick(
  controller: { cron: string; scheduledTime?: number },
  env: Env,
) {
  // Reject every native D1-like binding, including renamed accidental binds.
  // Native operational writes must never survive on the borrower.
  if (
    !enrolled(env) ||
    Object.values(env).some(
      (value) =>
        value && typeof value === "object" && typeof (value as CatalogDB).prepare === "function",
    ) ||
    !env.LEGAL_AUTHORITY?.getByName
  )
    throw Error("qa_scheduled_caller_not_enrolled");
  const command = checkedCommand({
    schema: QA_SCHEDULE_SCHEMA,
    cron: controller.cron,
    slot: Math.floor((controller.scheduledTime ?? Date.now()) / 60_000),
  });
  const owner = env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1");
  // One attempt only. An uncertain acknowledgement is not permission to
  // repeat side effects. Replay of this exact minute uses the owner journal.
  const response = await owner.fetch(
    new Request("https://legal-authority.internal" + QA_SCHEDULE_ROUTE, {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.COVE_RIGHTS_OWNER_SECRET,
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify(command),
    }),
  );
  if (response.status !== 200 || response.headers.get("cache-control") !== "no-store")
    throw Error("qa_scheduled_owner_not_acknowledged");
  return checkedReceipt(await response.json(), command);
}

export async function serveQaOwnerScheduledTick(
  request: Request,
  env: Env,
  storage: Storage,
  self: Port,
) {
  const reply = (status: number, body?: unknown) =>
    body
      ? Response.json(body, { status, headers: NO_STORE })
      : new Response(null, { status, headers: NO_STORE });
  if (
    !enrolled(env) ||
    !env.PRIMARY_DB?.prepare ||
    !env.PRIMARY_DB.batch ||
    Object.entries(env).some(
      ([key, value]) =>
        key !== "PRIMARY_DB" &&
        value &&
        typeof value === "object" &&
        typeof (value as CatalogDB).prepare === "function",
    )
  )
    return reply(503);
  if (request.headers.get("authorization") !== "Bearer " + env.COVE_RIGHTS_OWNER_SECRET)
    return reply(401);
  const url = new URL(request.url);
  if (url.pathname !== QA_SCHEDULE_ROUTE || url.search) return reply(404);
  if (
    request.method !== "POST" ||
    request.headers.get("content-type") !== "application/json" ||
    request.headers.has("cookie")
  )
    return reply(405);
  let command: Command;
  try {
    const body = await request.text();
    if (body.length > 512) return reply(413);
    command = checkedCommand(JSON.parse(body));
  } catch {
    return reply(400);
  }
  const sql = storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_qa_scheduled_tick_receipts(cron TEXT NOT NULL,slot INTEGER NOT NULL,state TEXT NOT NULL,receipt_json TEXT,PRIMARY KEY(cron,slot))",
  );
  const claim = storage.transactionSync(() => {
    const old = sql
      .exec<{ state: string; receipt_json: string | null }>(
        "SELECT state,receipt_json FROM cove_qa_scheduled_tick_receipts WHERE cron=? AND slot=?",
        command.cron,
        command.slot,
      )
      .toArray()[0];
    if (old) return { fresh: false, ...old };
    sql.exec(
      "INSERT INTO cove_qa_scheduled_tick_receipts(cron,slot,state) VALUES(?,?,'pending')",
      command.cron,
      command.slot,
    );
    return { fresh: true, state: "pending", receipt_json: null };
  });
  if (!claim.fresh) {
    if (claim.state !== "complete") return reply(claim.state === "pending" ? 409 : 503);
    try {
      return reply(200, checkedReceipt(JSON.parse(claim.receipt_json!), command));
    } catch {
      return reply(503);
    }
  }
  const tasks: Promise<unknown>[] = [];
  let synchronousFailure = false;
  try {
    // The original native handle remains unbranded. Canonical mutations
    // fail at BOTH original domain fences; their typed handlers use the
    // independently validated original PRIMARY_DB on this same owner.
    const db = bindPublicationOwner(
      commerceRestrictedCanonicalD1(makeStageLegalWriterLock(env.PRIMARY_DB)),
      {
        owner: self,
        secret: env.COVE_RIGHTS_OWNER_SECRET!,
        territory: "US",
        currency: "USD",
      },
    );
    const { PRIMARY_DB: _privateNativeHandle, ...borrowedEnv } = env;
    const execution = {
      ...borrowedEnv,
      DB: db,
      COVE_QA_SCHEDULE_OWNER_ENABLED: "0",
      COVE_QA_OWNER_UNBOUND_READ_ENABLED: "0",
      COVE_PUBLICATION_COMMANDS_ENABLED: "0",
    } as BackendEnv;
    const { scheduleBackendOwnedWork } = await import("../persistence-backend.worker");
    scheduleBackendOwnedWork({ cron: command.cron }, execution, {
      waitUntil(promise) {
        const task = Promise.resolve(promise);
        task.catch(() => {});
        tasks.push(task);
      },
    });
  } catch {
    synchronousFailure = true;
  }
  const settled = await Promise.allSettled(tasks);
  try {
    if (synchronousFailure || !tasks.length) throw Error("qa_scheduled_work_failed");
    assertCronSettled(settled);
    const receipt = checkedReceipt(
      { ...command, completed: true, ownerFirst: true, taskCount: tasks.length },
      command,
    );
    sql.exec(
      "UPDATE cove_qa_scheduled_tick_receipts SET state='complete',receipt_json=? WHERE cron=? AND slot=? AND state='pending'",
      JSON.stringify(receipt),
      command.cron,
      command.slot,
    );
    return reply(200, receipt);
  } catch {
    sql.exec(
      "UPDATE cove_qa_scheduled_tick_receipts SET state='failed' WHERE cron=? AND slot=? AND state='pending'",
      command.cron,
      command.slot,
    );
    return reply(503);
  }
}
