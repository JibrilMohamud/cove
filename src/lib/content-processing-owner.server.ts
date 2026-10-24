import type { CoveEnv } from "../features/fore/api.server";

export type ContentOwner = "legacy" | "draining" | "external";

/**
 * Primary D1 is the single owner authority. No dependency on eventually
 * consistent KV, Worker environment flags or an inferred deployment state.
 *
 * Missing keys retain legacy scheduling; an unrecognized value fails closed.
 * The asset lease also repeats this predicate atomically at primary D1 write.
 */
export async function contentPipelineOwner(
  db: CoveEnv["DB"],
  role: "assets" | "literary",
): Promise<string> {
  const key = role === "assets" ? "content_assets_owner" : "content_literary_owner";
  const row = await db
    .prepare("SELECT value FROM cove_runtime_config WHERE key=?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? "legacy";
}

export const assetOwnerPredicate =
  "COALESCE((SELECT value FROM cove_runtime_config" +
  " WHERE key='content_assets_owner'),'legacy')=?";
