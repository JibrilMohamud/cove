/**
 * Private synthetic-QA owner execution, on the owner's native primary only.
 * Existing legal and commerce fences remain in force. The command registry
 * contains only display-cache, anonymous search and HTTP observability writes.
 */
import { z } from "zod/v3";
import type { CatalogDB } from "../features/fore/catalog-model.server";
import { writeCatalogCache } from "../features/fore/catalog-cache.server";
import { validPublicFacetProjection } from "../features/fore/search-presentation-r2.server";
import { makeStageLegalWriterLock } from "./legal-primary-write-lock";
import { commerceRestrictedCanonicalD1 } from "./commerce-d1-write-fence";
import {
  QA_OPERATIONAL_ROUTE,
  QA_OPERATIONAL_SCHEMA,
  operationalCommand,
  qaOperationalEnrolled,
} from "./qa-owner-operational-protocol";

type Env = Parameters<typeof qaOperationalEnrolled>[0] & { PRIMARY_DB?: CatalogDB };
type Sql = {
  exec<T = Record<string, unknown>>(sql: string, ...args: unknown[]): { toArray(): T[] };
};
type Storage = { sql: Sql; transactionSync<T>(fn: () => T): T };
type Action = z.output<typeof operationalCommand>["action"];
const headers = { "cache-control": "no-store" };
const deny = () => {
  throw Error("qa_operational_invalid_action");
};
const json = (s: string) => JSON.parse(s) as unknown;
const taxonomy = z
  .array(
    z
      .object({
        node_id: z.string().min(1).max(256),
        product_count: z.number().int().nonnegative().safe(),
      })
      .strict(),
  )
  .max(300);
const impressions = z
  .array(
    z
      .object({
        productId: z.string().min(1).max(256),
        position: z.number().int().positive().safe(),
      })
      .strict(),
  )
  .max(200);

function validateCache(action: Extract<Action, { kind: "cache.write" }>, now: number) {
  if (
    !action.key.startsWith(action.prefix) ||
    action.limit !== (action.prefix === "search-page:v1:" ? 256 : 128) ||
    action.expiresAt <= now ||
    action.expiresAt > now + (action.prefix === "public-api:v2:" ? 1800000 : 600000)
  )
    deny();
  const data = json(action.body);
  if (
    action.prefix === "search-counts:v1:" &&
    !(typeof data === "number" && Number.isSafeInteger(data) && data >= 0)
  )
    deny();
  if (action.prefix === "taxonomy-counts:v1:") taxonomy.parse(data);
  if (action.prefix === "search-facets:v2:" && !validPublicFacetProjection(data)) deny();
  if (action.prefix === "search-page:v1:") {
    z.object({
      ids: z.array(z.string().min(1).max(256)).max(200),
      count: z.number().int().nonnegative().safe(),
      facets: z.unknown(),
      expression: z.string().max(16384),
      correctedQuery: z.string().max(512).optional(),
    })
      .strict()
      .parse(data);
    if (!validPublicFacetProjection((data as { facets: unknown }).facets)) deny();
  }
  if (
    action.prefix === "public-api:v2:" &&
    (!data || typeof data !== "object" || Array.isArray(data))
  )
    deny();
  if (action.guard) {
    const expected =
      action.prefix === "taxonomy-counts:v1:"
        ? "taxonomy-counts-refresh:v1:global"
        : action.prefix === "search-facets:v2:"
          ? "search-facets-refresh:v2:" + action.key.slice(action.prefix.length)
          : null;
    if (action.guard.key !== expected || Math.abs(action.guard.nowMs - now) > 30000) deny();
  }
}

async function execute(db: CatalogDB, action: Action): Promise<boolean> {
  const now = Date.now();
  switch (action.kind) {
    case "cache.write":
      validateCache(action, now);
      await writeCatalogCache(
        db,
        action.key,
        action.body,
        action.expiresAt,
        action.prefix,
        action.limit,
        action.guard ? { ...action.guard, nowMs: now } : undefined,
      );
      return true;
    case "cache.lease-acquire": {
      const ttl = action.key.startsWith("taxonomy-counts") ? 30000 : 45000;
      if (action.expiresAt <= now || action.expiresAt > now + ttl) deny();
      const lease = await db
        .prepare(
          `INSERT INTO api_cache(key,body,expires_at) VALUES(?,?,?)
         ON CONFLICT(key) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at
         WHERE api_cache.expires_at<=? RETURNING body`,
        )
        .bind(action.key, action.owner, action.expiresAt, now)
        .first<{ body: string }>();
      return lease?.body === action.owner;
    }
    case "cache.lease-release":
      await db
        .prepare("DELETE FROM api_cache WHERE key=? AND body=?")
        .bind(action.key, action.owner)
        .run();
      return true;
    case "search.impression": {
      const filters = json(action.filtersJson);
      if (!filters || typeof filters !== "object" || Array.isArray(filters)) deny();
      impressions.parse(json(action.impressionsJson));
      if (Math.abs(Date.parse(action.at) - now) > 60000) deny();
      await db
        .prepare(
          "INSERT INTO search_query_events(id,user_id,query,normalized_query,filters_json,sort,result_count,backend,duration_ms,corrected_query,result_impressions_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          action.id,
          null,
          action.query,
          action.normalizedQuery,
          action.filtersJson,
          action.sort,
          action.count,
          action.backend,
          action.duration,
          action.correctedQuery,
          action.impressionsJson,
          action.at,
        )
        .run();
      return true;
    }
    case "audit.http": {
      if (
        Math.abs(Date.parse(action.endedAt) - now) > 60000 ||
        Date.parse(action.startedAt) > Date.parse(action.endedAt)
      )
        deny();
      const id = (prefix: string) => prefix + "_" + crypto.randomUUID();
      await db.batch([
        db
          .prepare(
            "INSERT OR IGNORE INTO ops_http_requests(id,request_id,trace_id,span_id,parent_span_id,method,route,status_code,duration_ms,actor_kind,storefront_country,error_class,sampled,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
          )
          .bind(
            id("httpreq"),
            action.requestId,
            action.traceId,
            action.spanId,
            action.parentSpanId,
            action.method,
            action.route,
            action.status,
            action.duration,
            action.actorKind,
            action.storefrontCountry,
            action.errorClass,
            action.startedAt,
          ),
        db
          .prepare(
            "INSERT INTO ops_trace_spans(id,trace_id,span_id,parent_span_id,span_name,span_kind,status,started_at,ended_at,duration_ms,attributes_json) VALUES(?,?,?,?,?,'server',?,?,?,?,?)",
          )
          .bind(
            id("span"),
            action.traceId,
            action.spanId,
            action.parentSpanId,
            action.method + " " + action.route,
            action.status >= 500 ? "error" : "ok",
            action.startedAt,
            action.endedAt,
            action.duration,
            JSON.stringify({
              statusCode: action.status,
              requestId: action.requestId,
              actorKind: action.actorKind,
              storefrontCountry: action.storefrontCountry,
            }),
          ),
        db
          .prepare(
            "INSERT INTO ops_metric_points(id,metric_name,metric_type,value,unit,labels_json,observed_at) VALUES(?, 'http.server.duration','histogram',?,'ms',?,?)",
          )
          .bind(
            id("metric"),
            action.duration,
            JSON.stringify({
              method: action.method,
              route: action.route,
              statusClass: Math.floor(action.status / 100) + "xx",
            }),
            action.endedAt,
          ),
      ]);
      return true;
    }
  }
}
export async function serveQaOperationalWrite(request: Request, env: Env, storage: Storage) {
  const fail = (status: number) => new Response(null, { status, headers });
  if (
    !qaOperationalEnrolled(env) ||
    !env.PRIMARY_DB?.prepare ||
    !env.PRIMARY_DB.batch ||
    Object.entries(env).some(
      ([key, value]) =>
        key !== "PRIMARY_DB" &&
        value &&
        typeof value === "object" &&
        typeof (value as { prepare?: unknown }).prepare === "function",
    )
  )
    return fail(503);
  if (request.headers.get("authorization") !== "Bearer " + env.COVE_RIGHTS_OWNER_SECRET)
    return fail(401);
  const url = new URL(request.url);
  if (url.pathname !== QA_OPERATIONAL_ROUTE || url.search) return fail(404);
  if (
    request.method !== "POST" ||
    request.headers.get("content-type") !== "application/json" ||
    request.headers.has("cookie")
  )
    return fail(405);
  let command: z.output<typeof operationalCommand>, digest: string;
  try {
    const raw = await request.text();
    if (raw.length > 600000) return fail(413);
    command = operationalCommand.parse(JSON.parse(raw));
    digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return fail(400);
  }
  const sql = storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_qa_operational_receipts(operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,result INTEGER)",
  );
  const claim = storage.transactionSync(() => {
    const old = sql
      .exec<{ digest: string; state: string; result: number | null }>(
        "SELECT digest,state,result FROM cove_qa_operational_receipts WHERE operation_id=?",
        command.operationId,
      )
      .toArray()[0];
    if (old) return { fresh: false, ...old };
    sql.exec(
      "INSERT INTO cove_qa_operational_receipts(operation_id,digest,state) VALUES(?,?,'pending')",
      command.operationId,
      digest,
    );
    return { fresh: true, digest, state: "pending", result: null };
  });
  const receipt = (completed: boolean) =>
    Response.json(
      {
        schema: QA_OPERATIONAL_SCHEMA,
        operationId: command.operationId,
        kind: command.action.kind,
        completed,
      },
      { headers },
    );
  if (!claim.fresh) {
    if (claim.digest !== digest) return fail(409);
    if (claim.state !== "complete" || ![0, 1].includes(claim.result ?? -1)) return fail(503);
    return receipt(claim.result === 1);
  }
  try {
    // Neither domain fence is disabled, even for QA. No native handle leaves
    // the owner. Failed/uncertain operations never receive a success receipt.
    const db = commerceRestrictedCanonicalD1(makeStageLegalWriterLock(env.PRIMARY_DB));
    const completed = await execute(db, command.action);
    sql.exec(
      "UPDATE cove_qa_operational_receipts SET state='complete',result=? WHERE operation_id=? AND state='pending'",
      completed ? 1 : 0,
      command.operationId,
    );
    return receipt(completed);
  } catch {
    sql.exec(
      "UPDATE cove_qa_operational_receipts SET state='failed' WHERE operation_id=? AND state='pending'",
      command.operationId,
    );
    return fail(503);
  }
}
