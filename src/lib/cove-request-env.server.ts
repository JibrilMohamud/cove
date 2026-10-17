import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Nitro and Vercel both invoke the same SSR entry, but only a Cloudflare
 * request provides live D1/R2 bindings. Keep those per-request bindings in an
 * asynchronous scope; never put them in a process-global variable or cache.
 */
const coveRequestEnvironment = new AsyncLocalStorage<Record<string, unknown>>();

export function withCoveRequestEnvironment<T>(env: unknown, execute: () => T): T {
  const scoped = env && typeof env === "object" ? (env as Record<string, unknown>) : {};
  return coveRequestEnvironment.run(scoped, execute);
}

export function currentCoveRequestEnvironment(): Record<string, unknown> | undefined {
  return coveRequestEnvironment.getStore();
}
