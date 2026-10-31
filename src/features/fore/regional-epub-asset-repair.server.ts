import type { CoveEnv } from "./api.server";
import { dispatchRegionalEpubRepair } from "../../storefront-strangler/publication-owner-routing.server";
/** Fixed owner command. Only the independently bound owner reads R2 or mutates asset pointers. */
export async function repairRegionalEpubAssets(
  env: Pick<CoveEnv, "DB" | "BUCKET">,
  options: { after?: string; limit?: number } = {},
) {
  const after = options.after ?? "";
  if (!/^[a-z0-9_]{0,90}$/.test(after)) throw Error("Invalid regional asset repair cursor");
  const limit = Math.max(1, Math.min(16, Math.floor(options.limit ?? 8) || 8));
  return dispatchRegionalEpubRepair(env.DB, { after, limit });
}
