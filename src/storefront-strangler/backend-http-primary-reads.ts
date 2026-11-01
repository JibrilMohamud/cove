import type { CoveEnv } from "../features/fore/api.server";
import {
  canonicalReadonlyD1,
  type CanonicalReadService,
} from "../lib/canonical-readonly-d1.server";

/**
 * Strict opt-in for HTTP paths that have independently reviewed, read-only
 * query bodies. This does NOT convert the rest of the HTTP API into an
 * owner-authorized execution path, and it does not retire the native D1
 * binding while any transactional HTTP or cron mutation remains.
 */
export type BackendHttpReadEnv = {
  DB: CoveEnv["DB"];
  COVE_BACKEND_HTTP_READONLY_RPC?: string;
  COVE_CANONICAL_READONLY_RPC?: string;
  COVE_CANONICAL_READONLY?: CanonicalReadService;
};

export function backendHttpPrimaryReadDb(env: BackendHttpReadEnv): CoveEnv["DB"] {
  if (env.COVE_BACKEND_HTTP_READONLY_RPC === undefined) return env.DB;
  if (
    env.COVE_BACKEND_HTTP_READONLY_RPC !== "1" ||
    env.COVE_CANONICAL_READONLY_RPC !== "1" ||
    typeof env.COVE_CANONICAL_READONLY?.query !== "function"
  )
    throw new Error("http_primary_read_owner_unavailable");

  // Never retry a failed provider query through env.DB. The separate service
  // authenticates with D1 Read ONLY and requires served_by_primary on every
  // statement, so neither stale replicas nor a native driver can authorize it.
  return canonicalReadonlyD1(env.COVE_CANONICAL_READONLY) as unknown as CoveEnv["DB"];
}
