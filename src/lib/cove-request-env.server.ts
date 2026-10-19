import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Keep native Worker bindings AND the request-lifetime scheduler in one
 * asynchronous scope. Neither D1 nor waitUntil may leak between visitors.
 * Vercel has no Worker lifecycle: its requests continue to await logging.
 */
export type CoveRequestExecution = {
  waitUntil(work: Promise<unknown>): void;
};

type CoveRequestScope = {
  environment: Record<string, unknown>;
  execution?: CoveRequestExecution;
  prefetchedAnonymousBootstrap?: Promise<Response>;
};

const coveRequestScope = new AsyncLocalStorage<CoveRequestScope>();

export function withCoveRequestEnvironment<T>(
  env: unknown,
  execute: () => T,
  execution?: CoveRequestExecution,
  prefetchedAnonymousBootstrap?: Promise<Response>,
): T {
  const environment = env && typeof env === "object" ? (env as Record<string, unknown>) : {};
  return coveRequestScope.run({ environment, execution, prefetchedAnonymousBootstrap }, execute);
}

export function currentCoveRequestEnvironment(): Record<string, unknown> | undefined {
  return coveRequestScope.getStore()?.environment;
}

/** Return only the trusted Worker lifecycle supplied by the entry point. */
export function currentCoveRequestExecutionContext(): CoveRequestExecution | undefined {
  return coveRequestScope.getStore()?.execution;
}

/** In-flight and request-local ONLY: no shared user data or rights snapshot. */
export function currentCoveRequestAnonymousBootstrap(): Promise<Response> | undefined {
  return coveRequestScope.getStore()?.prefetchedAnonymousBootstrap;
}
