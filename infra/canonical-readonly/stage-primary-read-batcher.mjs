// Isolated, nonproduction fetch-transport experiment ONLY. D1 executes every
// statement against the primary; this does not cache or coalesce SQL results.
// Each request gets only its own slice of the provider's ordered results.
const MAX_REST_BYTES = 512 * 1024;
const encoder = new TextEncoder();

export function createStagePrimaryReadBatcher({
  windowMs = 2,
  maxWaiters = 8,
  maxStatements = 80,
  maxBytes = 256 * 1024,
} = {}) {
  let pending = [];
  let totalStatements = 0;
  let totalBytes = 0;
  let timer = null;

  function drain() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending.length) return;
    const jobs = pending;
    pending = [];
    totalStatements = 0;
    totalBytes = 0;
    const batch = jobs.flatMap((job) => job.statements);
    // Any upstream error denies ALL requests, never returns partial or
    // mismatched rights. No SQL, parameters, tokens, or provider text logged.
    Promise.resolve()
      .then(() => jobs[0].execute(batch))
      .then((rows) => {
        if (!Array.isArray(rows) || rows.length !== batch.length)
          throw new Error("Incomplete staged primary read");
        let cursor = 0;
        for (const job of jobs) {
          const end = cursor + job.statements.length;
          job.resolve(rows.slice(cursor, end));
          cursor = end;
        }
      })
      .catch(() => {
        for (const job of jobs) job.reject(new Error("Staged primary read unavailable"));
      });
  }

  return function stagePrimaryRead(statements, execute) {
    return new Promise((resolve, reject) => {
      if (
        !Array.isArray(statements) ||
        statements.length < 1 ||
        statements.length > 100 ||
        statements.some(
          (row) =>
            !row ||
            typeof row.sql !== "string" ||
            !row.sql.length ||
            row.sql.length > 100_000 ||
            !Array.isArray(row.params) ||
            row.params.length > 100,
        ) ||
        typeof execute !== "function"
      ) {
        reject(new Error("Invalid staged primary read"));
        return;
      }
      let bytes;
      try {
        bytes = encoder.encode(JSON.stringify({ batch: statements })).byteLength;
      } catch {
        reject(new Error("Invalid staged primary read"));
        return;
      }
      if (bytes > MAX_REST_BYTES) {
        reject(new Error("Staged primary read exceeds limit"));
        return;
      }
      // Large, valid requests remain independent. Never silently split one
      // logical request, change its SQL order, or exceed the provider cap.
      if (statements.length > maxStatements || bytes > maxBytes) {
        void Promise.resolve()
          .then(() => execute(statements))
          .then(resolve, () => reject(new Error("Staged primary read unavailable")));
        return;
      }
      if (
        pending.length &&
        (pending.length >= maxWaiters ||
          totalStatements + statements.length > maxStatements ||
          totalBytes + bytes > maxBytes)
      )
        drain();
      pending.push({ statements, execute, resolve, reject });
      totalStatements += statements.length;
      totalBytes += bytes;
      if (pending.length >= maxWaiters) drain();
      else if (timer === null) timer = setTimeout(drain, windowMs);
    });
  };
}
