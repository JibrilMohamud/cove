import type { CoveEnv } from "./api.server";
import { runCatalogAssetMaintenance } from "./api.server";
import { assetOwnerPredicate } from "../../lib/content-processing-owner.server";

export type AssetRunnerEnv = CoveEnv & {
  FORE_ASSETS_PER_MINUTE?: string;
  FORE_CONTENT_PROCESSOR_ROLE?: string;
};
/** One serial downloader per deployment keeps peak EPUB memory and upstream load bounded.
 * Metadata discovery has a separate schedule and cannot consume this work window.
 */
export async function runStoredAssetTick(env: AssetRunnerEnv) {
  const requested = Number(env.FORE_ASSETS_PER_MINUTE ?? 32);
  const limit = Number.isFinite(requested) ? Math.max(0, Math.min(64, Math.floor(requested))) : 0;
  if (!limit || !env.BUCKET) return { skipped: "disabled" };
  const started = new Date().toISOString();
  const token = crypto.randomUUID();
  const owner = env.FORE_CONTENT_PROCESSOR_ROLE === "assets" ? "external" : "legacy";
  const lease = await env.DB.prepare(
    `INSERT INTO catalog_asset_runner(id,lease_token,lease_until,started_at)
     SELECT 1,?,?,? WHERE ${assetOwnerPredicate}
     ON CONFLICT(id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until,started_at=excluded.started_at
     WHERE catalog_asset_runner.lease_until<=? AND ${assetOwnerPredicate} RETURNING lease_token`,
  )
    .bind(token, new Date(Date.now() + 120_000).toISOString(), started, owner, started, owner)
    .first<{ lease_token: string }>();
  if (!lease) return { skipped: "leased" };
  try {
    // Serial attempts, at most 50 seconds. Atomic per-file claims also protect
    // against an on-demand transfer or the authenticated maintenance endpoint.
    const result = await runCatalogAssetMaintenance(env, limit, Date.now() + 50_000);
    await env.DB.prepare(
      `UPDATE catalog_asset_runner SET lease_until='',finished_at=?,attempted=attempted+?,stored=stored+?,failed=failed+?,last_result_json=?
       WHERE id=1 AND lease_token=?`,
    )
      .bind(
        new Date().toISOString(),
        result.attempted,
        result.downloaded,
        result.failed,
        JSON.stringify(result),
        token,
      )
      .run();
    console.info(JSON.stringify({ event: "stored_asset_tick", ...result }));
    return result;
  } catch (error) {
    // Leave a short lease after infrastructure failure to avoid a hot retry loop.
    console.error("Stored asset tick interrupted; lease will expire.");
    throw error;
  }
}
