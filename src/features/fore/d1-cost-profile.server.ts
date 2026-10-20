import type { CatalogDB } from "./catalog-model.server";

type Sample = {
  statement: string;
  operation: string;
  wallMs: number;
  sqlMs: number | null;
  serviceResidualMs: number | null;
  rowsRead: number | null;
  rowsWritten: number | null;
  servedByPrimary: boolean | null;
  success: boolean;
};
function fingerprint(sql: string) {
  // Stable code identity only; never log SQL, bound values, user IDs or query terms.
  let h = 2166136261;
  for (const c of sql.replace(/\s+/g, " ").trim()) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}
export function profileD1(db: CatalogDB) {
  const samples: Sample[] = [];
  let dropped = 0;
  let startedStatements = 0,
    completedStatements = 0;
  const sources = new WeakMap<object, { raw: object; sql: string }>();
  const numeric = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  function record(
    sql: string,
    operation: string,
    started: number,
    value: unknown,
    success: boolean,
  ) {
    completedStatements++;
    const wallMs = performance.now() - started;
    const meta = (
      value as {
        meta?: {
          timings?: { sql_duration_ms?: number };
          rows_read?: number;
          rows_written?: number;
          served_by_primary?: boolean;
        };
      } | null
    )?.meta;
    const sqlMs = numeric(meta?.timings?.sql_duration_ms);
    const sample = {
      statement: fingerprint(sql),
      operation,
      wallMs,
      sqlMs,
      // Includes transport and scheduling; NOT a measurement of queue time alone.
      serviceResidualMs: sqlMs === null ? null : Math.max(0, wallMs - sqlMs),
      rowsRead: numeric(meta?.rows_read),
      rowsWritten: numeric(meta?.rows_written),
      servedByPrimary: typeof meta?.served_by_primary === "boolean" ? meta.served_by_primary : null,
      success,
    };
    if (samples.length < 200) samples.push(sample);
    else dropped++;
  }
  function wrapStatement(raw: object, sql: string): object {
    const wrapped = new Proxy(raw, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "bind")
          return (...args: unknown[]) => wrapStatement(value.apply(target, args), sql);
        if (["all", "run", "first", "raw"].includes(String(property)))
          return async (...args: unknown[]) => {
            const started = performance.now();
            startedStatements++;
            try {
              const result = await value.apply(target, args);
              record(sql, String(property), started, result, true);
              return result;
            } catch (error) {
              record(sql, String(property), started, null, false);
              throw error;
            }
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    sources.set(wrapped, { raw, sql });
    return wrapped;
  }
  function wrapDB(raw: CatalogDB): CatalogDB {
    return new Proxy(raw, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "prepare")
          return (sql: string) => wrapStatement(value.call(target, sql), sql);
        if (property === "withSession" && typeof value === "function")
          return (...args: unknown[]) => wrapDB(value.apply(target, args));
        if (property === "batch")
          return async (statements: object[]) => {
            const entries = statements.map((s) => sources.get(s));
            startedStatements += statements.length;
            const started = performance.now();
            try {
              const result = await value.call(
                target,
                statements.map((s, i) => entries[i]?.raw || s),
              );
              statements.forEach((_, i) =>
                record(entries[i]?.sql || "batch", "batch", started, result[i], true),
              );
              return result;
            } catch (error) {
              statements.forEach((_, i) =>
                record(entries[i]?.sql || "batch", "batch", started, null, false),
              );
              throw error;
            }
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return {
    db: wrapDB(db),
    samples,
    snapshot: () => ({
      statements: startedStatements,
      pendingStatements: startedStatements - completedStatements,
      dropped,
      samples: [...samples],
    }),
  };
}
