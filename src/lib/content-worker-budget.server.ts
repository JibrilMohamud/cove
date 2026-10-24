import type { CoveEnv } from "../features/fore/api.server";

type D1 = CoveEnv["DB"];
type Statement = ReturnType<D1["prepare"]>;
type BucketPut = NonNullable<CoveEnv["BUCKET"]>["put"];
export type ContentBudgetUsage = {
  d1Statements: number;
  d1Writes: number;
  d1ServiceMs: number;
  r2Bytes: number;
};

export type ContentBudgetLimits = {
  statements: number;
  writes: number;
  d1ServiceMs: number;
  r2Bytes: number;
  deadlineAt: number;
};
const safeCap = (raw: unknown, fallback: number, maximum: number) => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, maximum) : 0;
};

/**
 * Real executed operations, not claimed jobs. All limits are HARD:
 * the next D1 operation is refused rather than entering a new service queue.
 * D1 service time is measured after every operation, so a single slow query
 * cannot be interrupted, but all subsequent content queries are blocked.
 */
export function contentBudgetLimits(env: {
  FORE_CONTENT_MAX_D1_STATEMENTS?: string;
  FORE_CONTENT_MAX_D1_WRITES?: string;
  FORE_CONTENT_MAX_D1_SERVICE_MS?: string;
  FORE_CONTENT_MAX_R2_BYTES?: string;
}): ContentBudgetLimits {
  return {
    statements: safeCap(env.FORE_CONTENT_MAX_D1_STATEMENTS, 32, 100),
    writes: safeCap(env.FORE_CONTENT_MAX_D1_WRITES, 16, 50),
    d1ServiceMs: safeCap(env.FORE_CONTENT_MAX_D1_SERVICE_MS, 2000, 10000),
    r2Bytes: safeCap(env.FORE_CONTENT_MAX_R2_BYTES, 32 * 1024 * 1024, 128 * 1024 * 1024),
    deadlineAt: Date.now() + 40_000,
  };
}

const mutating = (sql: string) => !/^\s*(SELECT|EXPLAIN|PRAGMA)\b/i.test(sql);

export function meterContentAssetEnv(
  env: CoveEnv,
  limits: ContentBudgetLimits,
): { env: CoveEnv; usage: ContentBudgetUsage } {
  const usage: ContentBudgetUsage = {
    d1Statements: 0,
    d1Writes: 0,
    d1ServiceMs: 0,
    r2Bytes: 0,
  };
  const nativeStatements = new WeakMap<object, { native: Statement; sql: string }>();
  const assertBudget = (queries = 0, writes = 0, bytes = 0) => {
    if (
      Date.now() > limits.deadlineAt ||
      usage.d1Statements + queries > limits.statements ||
      usage.d1Writes + writes > limits.writes ||
      usage.d1ServiceMs >= limits.d1ServiceMs ||
      usage.r2Bytes + bytes > limits.r2Bytes
    )
      throw Error("content_asset_budget_exhausted");
  };
  const wrapStatement = (statement: Statement, sql: string): Statement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind")
          return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw")
          return async (...values: unknown[]) => {
            const writes = mutating(sql) ? 1 : 0;
            assertBudget(1, writes);
            usage.d1Statements++;
            usage.d1Writes += writes;
            const start = performance.now();
            try {
              const methods = target as unknown as Record<
                string,
                (...args: unknown[]) => Promise<unknown>
              >;
              const method = methods[prop];
              return await method.apply(target, values);
            } finally {
              usage.d1ServiceMs += performance.now() - start;
            }
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    nativeStatements.set(wrapped, { native: statement, sql });
    return wrapped;
  };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrapStatement(target.prepare(sql), sql);
      if (prop === "batch")
        return async (statements: Statement[]) => {
          const batch = statements.map((statement) => nativeStatements.get(statement));
          if (batch.some((item) => !item)) throw Error("unmetered_content_asset_batch");
          const writes = batch.filter((item) => mutating(item!.sql)).length;
          assertBudget(batch.length, writes);
          usage.d1Statements += batch.length;
          usage.d1Writes += writes;
          const start = performance.now();
          try {
            return await target.batch(batch.map((item) => item!.native));
          } finally {
            usage.d1ServiceMs += performance.now() - start;
          }
        };
      // No alternate execution interfaces are allowed for a metered lane.
      if (prop === "exec" || prop === "withSession" || prop === "dump")
        return () => {
          throw Error("unmetered_content_asset_database_operation");
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1;
  const bucket = env.BUCKET
    ? (new Proxy(env.BUCKET, {
        get(target, prop) {
          if (prop === "put")
            return async (key: string, value: unknown, options?: unknown) => {
              const bytes =
                typeof value === "string"
                  ? new TextEncoder().encode(value).byteLength
                  : value instanceof ArrayBuffer
                    ? value.byteLength
                    : ArrayBuffer.isView(value)
                      ? value.byteLength
                      : Number.POSITIVE_INFINITY;
              assertBudget(0, 0, bytes);
              usage.r2Bytes += bytes;
              return target.put(key, value as Parameters<BucketPut>[1], options as Parameters<BucketPut>[2]);
            };
          const method = Reflect.get(target, prop);
          return typeof method === "function" ? method.bind(target) : method;
        },
      }) as CoveEnv["BUCKET"])
    : env.BUCKET;
  return { env: { ...env, DB: db, BUCKET: bucket }, usage };
}
