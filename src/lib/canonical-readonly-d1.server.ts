type Query = { sql: string; params: unknown[] };
type Result = {
  success: boolean;
  results: Record<string, unknown>[];
  meta: Record<string, unknown>;
};
export interface CanonicalReadService {
  query(statements: Query[]): Promise<Result[]>;
}

/** Request-local D1 facade. No cache, replica, SQL filtering or write fallback. */
export function canonicalReadonlyD1(service: CanonicalReadService) {
  const descriptors = new WeakMap<object, Query>();
  function prepare(sql: string, params: unknown[] = []) {
    const statement = {
      bind(...values: unknown[]) {
        return prepare(
          sql,
          values.map((value) => {
            if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
            if (ArrayBuffer.isView(value))
              return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
            return value;
          }),
        );
      },
      async all() {
        return (await service.query([{ sql, params }]))[0];
      },
      async first(column?: string) {
        const row = (await statement.all()).results[0];
        if (!row) return null;
        if (column === undefined) return row;
        if (!(column in row)) throw new Error("D1 column does not exist");
        return row[column];
      },
      async run() {
        throw new Error("Canonical database is read-only");
      },
      async raw() {
        throw new Error("Raw reads are not supported by canonical read service");
      },
    };
    descriptors.set(statement, { sql, params });
    return statement;
  }
  const db = {
    prepare,
    async batch(statements: object[]) {
      const queries = statements.map((statement) => {
        const query = descriptors.get(statement);
        if (!query) throw new Error("Foreign canonical read statement");
        return query;
      });
      return service.query(queries);
    },
    withSession(constraint: string) {
      if (!["first-primary", "first-unconstrained"].includes(constraint))
        throw new Error("Unsupported canonical read session");
      // REST reads are required to prove served_by_primary on every response.
      return db;
    },
  };
  return db;
}
