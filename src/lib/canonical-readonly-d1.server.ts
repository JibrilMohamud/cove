import { boundedReadonlyPhaseMs } from "./readonly-transport-metric";

type Query = { sql: string; params: unknown[] };
type Result = {
  success: boolean;
  results: Record<string, unknown>[];
  meta: Record<string, unknown>;
};
export interface CanonicalReadService {
  query(statements: Query[]): Promise<Result[]>;
}

/**
 * Staging-only service-binding fetch adapter. Unlike query() RPC this calls
 * the reader's fetch handler, so Cloudflare may actually evaluate placement.
 * No HTTP URL is exposed: fetch is dispatched through the private service
 * binding. The returned D1 facade keeps the same primary-only decisions.
 */
export function canonicalReadonlyFetchTransport(service: {
  fetch(request: Request): Promise<Response>;
}): CanonicalReadService {
  return {
    async query(statements: Query[]): Promise<Result[]> {
      if (!Array.isArray(statements) || !statements.length || statements.length > 100)
        throw new Error("Invalid canonical read request");
      const encoded = JSON.stringify({ batch: statements });
      if (new TextEncoder().encode(encoded).byteLength > 512 * 1024)
        throw new Error("Canonical read request too large");
      const request = new Request("https://cove-private-stage.invalid/__cove/stage/primary-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encoded,
        redirect: "manual",
      });
      const response = await service.fetch(request);
      if (
        response.status !== 200 ||
        !response.headers.get("cache-control")?.includes("no-store") ||
        !response.headers.get("content-type")?.includes("application/json")
      )
        throw new Error("Canonical read unavailable");
      if (!response.body) throw new Error("Canonical read unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("Canonical read response too large");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let cursor = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, cursor);
        cursor += chunk.byteLength;
      }
      const data = JSON.parse(new TextDecoder().decode(bytes)) as { result?: Result[] };
      if (
        !Array.isArray(data?.result) ||
        data.result.length !== statements.length ||
        data.result.some(
          (row) =>
            row?.success !== true ||
            !Array.isArray(row.results) ||
            row.meta?.served_by_primary !== true,
        )
      )
        throw new Error("Canonical primary read unavailable");
      return data.result;
    },
  };
}

/** Request-local D1 facade. No cache, replica, SQL filtering or write fallback. */
export function canonicalReadonlyD1(service: CanonicalReadService) {
  const descriptors = new WeakMap<object, Query>();
  async function invoke(queries: Query[]): Promise<Result[]> {
    const started = performance.now();
    const response = await service.query(queries);
    if (!Array.isArray(response) || response.length !== queries.length)
      throw new Error("Incomplete canonical read result");
    // Legacy cove_rpc_wall_ms measures the whole private service round trip\n    // for both RPC and staging fetch; its field name is retained for parity.\n    const rpcMs = boundedReadonlyPhaseMs(started, performance.now());
    return response.map((row) => ({
      ...row,
      meta: { ...row.meta, ...(rpcMs === undefined ? {} : { cove_rpc_wall_ms: rpcMs }) },
    }));
  }
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
        return (await invoke([{ sql, params }]))[0];
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
      return invoke(queries);
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
