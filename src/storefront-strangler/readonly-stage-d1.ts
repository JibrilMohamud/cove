/** Hard prohibit D1 writes by the real-catalog, credential-gated preview. */
export function readOnlyStageD1<T extends object>(
  db: T,
  approved = new WeakMap<object, object>(),
): T {
  const wrapStatement = (statement: object): object => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) =>
            wrapStatement((target as { bind(...values: unknown[]): object }).bind(...args));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    approved.set(proxy, statement);
    return proxy;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          const trimmed = sql.trim();
          if (
            !/^(?:SELECT|WITH)\s/i.test(trimmed) ||
            /;\s*\S/.test(trimmed) ||
            /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM)\b/i.test(
              trimmed,
            )
          )
            throw new Error("Production catalog acceptance is read-only");
          const real = (target as { prepare(sql: string): object }).prepare(sql);
          return wrapStatement(real);
        };
      }
      if (key === "withSession") {
        const open = (target as { withSession?: (arg: string) => object }).withSession;
        if (typeof open !== "function") return undefined;
        return (constraint: string) => readOnlyStageD1(open.call(target, constraint), approved);
      }
      if (key === "batch") {
        return (statements: object[]) => {
          if (
            !Array.isArray(statements) ||
            !statements.length ||
            statements.some((statement) => !approved.has(statement))
          )
            throw new Error("Only validated SELECT batches may query production D1");
          return (target as { batch(statements: object[]): unknown }).batch(
            statements.map((statement) => approved.get(statement)!),
          );
        };
      }
      if (key === "exec")
        return () => {
          throw new Error("Production catalog acceptance cannot exec SQL");
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
