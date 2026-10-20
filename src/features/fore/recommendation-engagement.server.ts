import type { CatalogDB } from "./catalog-model.server";
import { ApiError, now } from "./service";

export type EngagementEnv = {
  DB: CatalogDB;
  ENGAGEMENT_DB?: CatalogDB;
  FORE_ENGAGEMENT_STORAGE?: string;
};
type ServingDB = CatalogDB & { recommendationEngagement?: CatalogDB };

/** Explicit domain selection; never route arbitrary SQL by table-name inspection. */
export function engagementDatabase(db: CatalogDB): CatalogDB {
  return (db as ServingDB).recommendationEngagement || db;
}

/** A request-local dependency wrapper. No mutable request or visitor state is global. */
export function attachEngagementDatabase(db: CatalogDB, engagement: CatalogDB): CatalogDB {
  if (db === engagement) throw new ApiError(503, "Engagement storage must be independent.");
  return new Proxy(db, {
    get(target, property) {
      if (property === "recommendationEngagement") return engagement;
      const value = Reflect.get(target, property);
      if (property === "withSession" && typeof value === "function")
        return (...args: unknown[]) =>
          attachEngagementDatabase(value.apply(target, args), engagement);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function scopeEngagementEnv<T extends EngagementEnv>(env: T): T {
  if (env.FORE_ENGAGEMENT_STORAGE !== "separate") return env;
  // Fail only operations which need engagement. A misconfigured analytical
  // dependency must not disable unrelated commerce/rights/account endpoints.
  if (!env.ENGAGEMENT_DB || env.ENGAGEMENT_DB === env.DB) {
    const unavailable = () => {
      throw new ApiError(503, "Engagement storage is unavailable.");
    };
    return {
      ...env,
      DB: attachEngagementDatabase(env.DB, { prepare: unavailable, batch: unavailable }),
    };
  }
  if (engagementDatabase(env.DB) === env.ENGAGEMENT_DB) return env;
  return { ...env, DB: attachEngagementDatabase(env.DB, env.ENGAGEMENT_DB) };
}

/** Permanent fence for deletion, committed atomically with removal in the independent ledger. */
export async function eraseEngagementUser(db: CatalogDB, userId: string) {
  const ledger = engagementDatabase(db);
  if (ledger === db) return;
  await ledger.batch([
    ledger
      .prepare("INSERT OR IGNORE INTO engagement_erased_users(user_id,erased_at) VALUES(?,?)")
      .bind(userId, now()),
    ledger
      .prepare(
        "DELETE FROM recommendation_events WHERE user_id=? OR recommendation_request_id IN (SELECT id FROM recommendation_requests WHERE user_id=?)",
      )
      .bind(userId, userId),
    ledger.prepare("DELETE FROM search_query_events WHERE user_id=?").bind(userId),
    ledger.prepare("DELETE FROM recommendation_requests WHERE user_id=?").bind(userId),
    ledger
      .prepare("DELETE FROM recommendation_jobs WHERE job_type='user-features' AND entity_id=?")
      .bind(userId),
  ]);
}
