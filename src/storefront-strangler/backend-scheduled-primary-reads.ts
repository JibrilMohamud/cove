import type { CoveEnv } from "../features/fore/api.server";
import {
  canonicalReadonlyD1,
  type CanonicalReadService,
} from "../lib/canonical-readonly-d1.server";

/** An opt-in, private scheduler-only read plane; does not authorize any writes. */
export type ScheduledPrimaryReadEnv = {
  DB: CoveEnv["DB"];
  COVE_BACKEND_SCHEDULED_READONLY_RPC?: string;
  COVE_CANONICAL_READONLY?: CanonicalReadService;
};

/**
 * Never downgrade from the restricted provider RPC to a native D1 binding
 * when its flag is present. Missing service/malformed flag means the entire
 * scheduling read fails and the caller must not treat absent proof as zero.
 * Unflagged production keeps its existing behavior until audited cutover.
 */
export function backendScheduledPrimaryReadDb(env: ScheduledPrimaryReadEnv): CoveEnv["DB"] {
  if (env.COVE_BACKEND_SCHEDULED_READONLY_RPC === undefined) return env.DB;
  if (
    env.COVE_BACKEND_SCHEDULED_READONLY_RPC !== "1" ||
    typeof env.COVE_CANONICAL_READONLY?.query !== "function"
  )
    throw new Error("scheduled_primary_read_owner_unavailable");

  // This facade deliberately implements only D1's read surface. Cloudflare
  // independently restricts the backing token to D1 Read, verifies
  // served_by_primary=true, and rejects all writer operations.
  return canonicalReadonlyD1(env.COVE_CANONICAL_READONLY) as unknown as CoveEnv["DB"];
}
