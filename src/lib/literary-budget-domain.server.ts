import type { CoveEnv } from "../features/fore/api.server";

export type LiteraryBudgetDomainEnv = Pick<CoveEnv, "DB"> & {
  CONTENT_DB?: CoveEnv["DB"];
  FORE_CONTENT_BUDGET_MODE?: string;
  FORE_CONTENT_PROCESSOR_ENABLED?: string;
  FORE_CONTENT_PROCESSOR_ROLE?: string;
};

/**
 * Split *only the inference reservation ledger*, not the rights authority,
 * catalog, job queue or literary-profile publication transactions.
 *
 * The primary D1 runtime flag is a deployment fence. Even a legacy worker
 * that still calls the normal literary analyzer must refuse new reservations
 * after the flag changes. The secondary D1 has a separate per-day fence.
 */
export async function resolveLiteraryBudgetDb(
  env: LiteraryBudgetDomainEnv,
  day: string,
): Promise<CoveEnv["DB"]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid literary ledger day");
  const primary = await env.DB.prepare(
    "SELECT value FROM cove_runtime_config WHERE key='literary_budget_domain'",
  ).first<{ value: string }>();
  const primaryMode = primary?.value || "primary";
  const requestedMode = env.FORE_CONTENT_BUDGET_MODE || "primary";
  if (primaryMode !== "primary" && primaryMode !== "isolated")
    throw new Error("Unknown literary budget authority");
  if (requestedMode === "primary") {
    if (primaryMode !== "primary") throw new Error("literary_budget_primary_fenced");
    return env.DB;
  }
  if (requestedMode !== "isolated") throw new Error("Unknown literary budget binding mode");
  if (
    env.FORE_CONTENT_PROCESSOR_ENABLED !== "1" ||
    (env.FORE_CONTENT_PROCESSOR_ROLE !== "literary" &&
      env.FORE_CONTENT_PROCESSOR_ROLE !== "literary-infer") ||
    !env.CONTENT_DB ||
    env.CONTENT_DB === env.DB ||
    primaryMode !== "isolated"
  )
    throw new Error("literary_budget_isolation_not_authorized");

  const cutover = await env.CONTENT_DB.prepare(
    "SELECT status," +
      " (SELECT domain FROM literary_budget_domain_identity" +
      " WHERE id=1 AND schema_version=1) domain," +
      " EXISTS(SELECT 1 FROM sqlite_master WHERE type='table'" +
      " AND name IN ('rights_grants','products','payment_orders')) contaminated" +
      " FROM literary_budget_cutover WHERE day=?",
  )
    .bind(day)
    .first<{ status: string; domain: string | null; contaminated: number }>();
  if (!cutover) throw new Error("literary_budget_day_not_seeded");
  if (cutover.domain !== "cove-isolated-literary-budget" || cutover.contaminated)
    throw new Error("literary_budget_binding_not_isolated");
  if (cutover.status !== "active") throw new Error("literary_budget_day_not_seeded");
  return env.CONTENT_DB;
}

export async function reserveLiteraryBudget(
  ledger: CoveEnv["DB"],
  day: string,
  units: number,
  dailyLimit: number,
  isolated: boolean,
) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isSafeInteger(units) ||
    !Number.isSafeInteger(dailyLimit) ||
    units < 0 ||
    dailyLimit < 0
  )
    throw new Error("Invalid literary budget reservation");
  if (!isolated) {
    return ledger
      .prepare(
        "INSERT INTO literary_profile_budget(day,reserved_units,calls)" +
          " SELECT ?,?,1 WHERE ?<=? AND NOT EXISTS(" +
          " SELECT 1 FROM cove_runtime_config WHERE key='literary_budget_domain'" +
          " AND value='isolated')" +
          " ON CONFLICT(day) DO UPDATE SET" +
          " reserved_units=reserved_units+excluded.reserved_units,calls=calls+1" +
          " WHERE reserved_units+excluded.reserved_units<=?" +
          " AND NOT EXISTS(SELECT 1 FROM cove_runtime_config" +
          " WHERE key='literary_budget_domain' AND value='isolated')" +
          " RETURNING calls",
      )
      .bind(day, units, units, dailyLimit, dailyLimit)
      .first();
  }
  // The transaction-local cutover predicate prevents further debits if an
  // operator closes the per-day ledger between the preflight and this write.
  return ledger
    .prepare(
      "INSERT INTO literary_profile_budget(day,reserved_units,calls)" +
        " SELECT ?,?,1 WHERE ?<=? AND EXISTS(" +
        " SELECT 1 FROM literary_budget_cutover WHERE day=? AND status='active')" +
        " AND EXISTS(SELECT 1 FROM literary_budget_domain_identity" +
        " WHERE id=1 AND domain='cove-isolated-literary-budget' AND schema_version=1)" +
        " AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table'" +
        " AND name IN ('rights_grants','products','payment_orders'))" +
        " ON CONFLICT(day) DO UPDATE SET" +
        " reserved_units=reserved_units+excluded.reserved_units,calls=calls+1" +
        " WHERE reserved_units+excluded.reserved_units<=?" +
        " AND EXISTS(SELECT 1 FROM literary_budget_cutover WHERE day=? AND status='active')" +
        " AND EXISTS(SELECT 1 FROM literary_budget_domain_identity" +
        " WHERE id=1 AND domain='cove-isolated-literary-budget' AND schema_version=1)" +
        " AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table'" +
        " AND name IN ('rights_grants','products','payment_orders'))" +
        " RETURNING calls",
    )
    .bind(day, units, units, dailyLimit, day, dailyLimit, day)
    .first();
}
