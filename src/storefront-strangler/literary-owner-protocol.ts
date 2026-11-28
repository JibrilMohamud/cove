import type { CatalogDB } from "../features/fore/catalog-model.server";
import { literarySourceRightsPredicate } from "../lib/literary-prepare-outbox.server";
import { literaryPreparationSourceSql } from "../lib/literary-preparation-domain.server";

export const LITERARY_READ_ROUTE = "/__cove/literary/primary-read";
export const LITERARY_HANDOFF_ROUTE = "/__cove/literary/handoff-tick";
export const LITERARY_PUBLICATION_ROUTE = "/__cove/literary/publish-inference";
export const LITERARY_READ_SCHEMA = "cove.literary-primary-read.v1";
// Exact existing statements map to fixed owner operations. SQL never crosses the port.
export const literaryReads = Object.freeze({
  processingOwner: {
    sql: "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'",
    count: 0,
  },
  budgetDomain: {
    sql: "SELECT value FROM cove_runtime_config WHERE key='literary_budget_domain'",
    count: 0,
  },
  dailyBudget: {
    sql: "SELECT value FROM cove_runtime_config WHERE key='literary_daily_units'",
    count: 0,
  },
  admission: { sql: "SELECT 1 AS ok", count: 0 },
  provisionalProfile: {
    sql: "SELECT fingerprint,revision FROM literary_profiles WHERE product_id=? AND status='provisional' AND policy_version=?",
    count: 2,
  },
  profileReceipt: {
    sql: "SELECT fingerprint,revision,status,coverage FROM literary_profiles WHERE product_id=?",
    count: 1,
  },
  currentSourceRights: {
    sql: "SELECT c.id" + literarySourceRightsPredicate + " AND c.id=? AND c.content_hash=? LIMIT 1",
    count: 4,
  },
  eligibleSource: { sql: literaryPreparationSourceSql, count: 2 },
});
export type LiteraryPort = { fetch(request: Request): Promise<Response> };
export type LiteraryReadEnv = {
  DB?: CatalogDB;
  LITERARY_PRIMARY_READER?: LiteraryPort;
  COVE_LITERARY_READ_SECRET?: string;
  COVE_LITERARY_PRIVATE_READ_ENABLED?: string;
};
export async function literaryOwnerCall(
  port: LiteraryPort,
  secret: string,
  route: string,
  body: unknown,
) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error("literary_owner_credential_unavailable");
  if (![LITERARY_READ_ROUTE, LITERARY_HANDOFF_ROUTE, LITERARY_PUBLICATION_ROUTE].includes(route))
    throw Error("literary_owner_route_invalid");
  const response = await port.fetch(
    new Request("https://literary-owner.internal" + route, {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    }),
  );
  if (response.status !== 200) throw Error("literary_owner_unavailable_" + response.status);
  const reader = response.body?.getReader();
  if (!reader) throw Error("literary_owner_response_missing");
  let text = "",
    size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        text += decoder.decode();
        break;
      }
      size += part.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw Error("literary_owner_response_oversize");
      }
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as Record<string, unknown>;
}
export function scopeLiteraryPrimaryReadEnv<T extends LiteraryReadEnv>(env: T): T {
  if (env.COVE_LITERARY_PRIVATE_READ_ENABLED !== "1") {
    if (env.LITERARY_PRIMARY_READER) throw Error("literary_read_mode_ambiguous");
    return env;
  }
  if (env.DB || !env.LITERARY_PRIMARY_READER) throw Error("literary_read_capability_invalid");
  const port = env.LITERARY_PRIMARY_READER,
    secret = env.COVE_LITERARY_READ_SECRET || "";
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error("literary_read_secret_invalid");
  const db: CatalogDB = {
    prepare(sql) {
      const found = Object.entries(literaryReads).find(([, read]) => read.sql === sql);
      if (!found) throw Error("literary_primary_statement_not_allowed");
      const [op, read] = found;
      const statement = (args: unknown[]): ReturnType<CatalogDB["prepare"]> => ({
        bind: (...values) => statement(values),
        async first<T>() {
          if (args.length !== read.count) throw Error("literary_read_arguments_invalid");
          const result = await literaryOwnerCall(port, secret, LITERARY_READ_ROUTE, { op, args });
          if (
            result.schema !== LITERARY_READ_SCHEMA ||
            result.op !== op ||
            !(
              result.row === null ||
              (result.row && typeof result.row === "object" && !Array.isArray(result.row))
            )
          )
            throw Error("literary_owner_response_invalid");
          return result.row as T | null;
        },
        async all<T>() {
          const row = await statement(args).first<T>();
          return { results: row === null ? [] : [row] };
        },
        async run() {
          throw Error("literary_primary_write_forbidden");
        },
      });
      return statement([]);
    },
    async batch() {
      throw Error("literary_primary_batch_forbidden");
    },
  };
  return { ...env, DB: db };
}
