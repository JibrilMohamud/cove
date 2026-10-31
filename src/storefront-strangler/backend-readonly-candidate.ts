import {
  canonicalReadonlyD1,
  type CanonicalReadService,
} from "../lib/canonical-readonly-d1.server";

/**
 * A private, nonproduction backend experiment. This is deliberately NOT the
 * production migration: mutation callers and scheduled queues still need
 * independently authorized owner commands before the canonical DB binding
 * can be retired from cove-persistence-backend.
 *
 * The candidate never receives a native D1 capability. Reads go through the
 * separately permissioned provider D1 Read service. Missing/ambiguous
 * bindings fail closed rather than falling back to a legacy DB driver.
 */
export type ReadonlyBackendCandidateEnv = {
  DB?: unknown;
  COVE_BACKEND_READONLY_CANDIDATE?: string;
  COVE_CANONICAL_READONLY_RPC?: string;
  COVE_CANONICAL_READONLY?: CanonicalReadService;
  FORE_ENVIRONMENT?: string;
  FORE_BACKEND_TOKEN_SHA256?: string;
  FORE_BACKEND_TOKEN?: string;
  COVE_BACKEND_TOKEN_HASH_ONLY?: string;
};

const READ_PATHS = new Set(["/__cove/health", "/api/fore/health/ready"]);

export function backendReadonlyCandidateRouteAllowed(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === "GET" && !url.search && !url.hash && READ_PATHS.has(url.pathname);
}

export function scopeBackendReadonlyCandidate<T extends ReadonlyBackendCandidateEnv>(env: T): T {
  const enabled = env.COVE_BACKEND_READONLY_CANDIDATE;
  if (enabled === undefined) return env;

  if (
    enabled !== "1" ||
    env.FORE_ENVIRONMENT !== "staging" ||
    env.COVE_BACKEND_TOKEN_HASH_ONLY !== "1" ||
    Boolean(env.FORE_BACKEND_TOKEN) ||
    env.DB !== undefined ||
    env.COVE_CANONICAL_READONLY_RPC !== "1" ||
    typeof env.COVE_CANONICAL_READONLY?.query !== "function" ||
    !/^[a-f0-9]{64}$/.test(env.FORE_BACKEND_TOKEN_SHA256 || "")
  )
    throw new Error("private_backend_readonly_candidate_not_certified");

  return {
    ...env,
    DB: canonicalReadonlyD1(env.COVE_CANONICAL_READONLY),
  } as T;
}
