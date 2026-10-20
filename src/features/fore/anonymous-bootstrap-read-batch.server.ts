import type { CoveEnv } from "./api.server";

type DB = CoveEnv["DB"];
type Statement = ReturnType<DB["prepare"]>;
type ReadResult = { results: unknown[]; success?: boolean };

/** Request-local transport for the bootstrap's three fixed SELECT queries.
 * Flush after launching their consumers. Native statements retain their D1
 * metadata, and all execute on the primary binding in one transaction.
 * Dependent page fallback reads after flush go directly to the same primary.
 * This is not a SQL sandbox or a cache; only trusted bootstrap code uses it.
 */
export function anonymousBootstrapReadBatch(primary: DB) {
  const pending: {
    statement: Statement;
    resolve: (result: ReadResult) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let dispatched = false;
  const wrap = (statement: Statement): Statement => {
    const all = <T>(): Promise<{ results: T[] }> => {
      if (dispatched) return statement.all<T>();
      if (pending.length >= 3) return Promise.reject(new Error("Bootstrap read batch exceeded"));
      return new Promise<ReadResult>((resolve, reject) => {
        pending.push({ statement, resolve, reject });
      }) as Promise<{ results: T[] }>;
    };
    return {
      bind: (...values) => wrap(statement.bind(...values)),
      all,
      first: async <T>() => (await all<T>()).results[0] ?? null,
      run: async () => {
        throw new Error("Bootstrap read batch does not support mutations");
      },
    };
  };
  const db: DB = {
    prepare: (sql) => wrap(primary.prepare(sql)),
    batch: async () => {
      throw new Error("Nested bootstrap batches are not supported");
    },
  };
  return {
    db,
    async flush() {
      if (dispatched) throw new Error("Bootstrap read batch already dispatched");
      dispatched = true;
      const reads = pending.splice(0);
      if (!reads.length) return;
      try {
        const results = await primary.batch(reads.map((read) => read.statement));
        if (
          !Array.isArray(results) ||
          results.length !== reads.length ||
          results.some((result) => !Array.isArray(result?.results) || result.success === false)
        )
          throw new Error("Incomplete bootstrap D1 batch result");
        if (results.some((result) => result.meta?.served_by_primary === false))
          throw new Error("Bootstrap batch must execute on primary D1");
        reads.forEach((read, index) => read.resolve(results[index]));
      } catch (error) {
        // Reject every consumer, including those queued before a later prepare
        // failed. Promise.all in the caller observes all of these rejections.
        reads.forEach((read) => read.reject(error));
      }
    },
  };
}
