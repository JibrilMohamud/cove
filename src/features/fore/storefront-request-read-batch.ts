/**
 * Request-owned batching of the two independent, source-controlled first-paint
 * SELECTs. Both still execute against the original primary D1 binding, with
 * their original SQL and parameters. No result or promise crosses requests.
 */
type Statement = { bind(...values: unknown[]): Statement; all(): Promise<unknown> };
type ReadDatabase = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
};
type PendingRead = {
  statement: Statement;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

function firstPaintRead(sql: string): boolean {
  return (
    (sql.startsWith("WITH RECURSIVE") &&
      sql.includes("active_market AS MATERIALIZED") &&
      sql.includes("chosen_locale AS MATERIALIZED") &&
      sql.includes("FROM active_market m LEFT JOIN chosen_locale l")) ||
    (sql.startsWith("WITH first_paint_currency(currency) AS MATERIALIZED") &&
      sql.includes("eligible AS MATERIALIZED") &&
      sql.includes("retail_product_availability_rows"))
  );
}

export function withRequestFirstPaintReadBatch<T extends object>(db: T): T {
  const native = db as T & ReadDatabase;
  if (typeof native.batch !== "function") return db;
  const pending: PendingRead[] = [];
  let open = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (!open || !pending.length) return;
    open = false;
    if (timer) clearTimeout(timer);
    const reads = pending.splice(0);
    // Native prepared statements only; the proxy never reaches batch().
    void Promise.resolve()
      .then(() => native.batch(reads.map((read) => read.statement)))
      .then((results) => {
        if (
          !Array.isArray(results) ||
          results.length !== reads.length ||
          results.some(
            (result) =>
              !result ||
              typeof result !== "object" ||
              !Array.isArray((result as { results?: unknown }).results) ||
              (result as { success?: unknown }).success === false,
          )
        )
          throw new Error("Incomplete primary first-paint read batch.");
        for (let i = 0; i < reads.length; i++) reads[i].resolve(results[i]);
      })
      .catch((error: unknown) => reads.forEach((read) => read.reject(error)));
  };
  const wrap = (statement: Statement): Statement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "all")
          return () => {
            if (!open) return target.all();
            const result = new Promise<unknown>((resolve, reject) => {
              pending.push({ statement: target, resolve, reject });
            });
            // Both initial reads are independent and scheduled in this turn.
            // Flush a lone read next turn too: a missing/failed peer cannot hang.
            if (pending.length === 2) flush();
            else timer = setTimeout(flush, 0);
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = native.prepare(sql);
          return open && firstPaintRead(sql) ? wrap(statement) : statement;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
