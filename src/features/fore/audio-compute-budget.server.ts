import type { CoveEnv } from "./api.server";

export type AudioComputeEnv = Pick<CoveEnv, "DB"> & {
  FORE_AUDIO_COMPUTE_MODE?: string;
  FORE_AUDIO_MONTHLY_SECONDS?: string;
  FORE_AUDIO_MIN_INTERVAL_SECONDS?: string;
};
const RESERVATION_SECONDS = 300;
function positive(value: string | undefined, fallback: number, max: number) {
  const n = value === undefined ? fallback : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : 0;
}
/** Default pause protects an exhausted allowance. Existing prepared media is unaffected.
 * A reservation charges a complete five-minute invocation, even on failure or
 * a lost reply. It is a conservative admission bound, not a billing measurement.
 */
export async function audioComputeAdmission(
  env: AudioComputeEnv,
  reserve = false,
  at = new Date(),
) {
  const period = at.toISOString().slice(0, 7);
  if (env.FORE_AUDIO_COMPUTE_MODE !== "budgeted")
    return { allowed: false, reason: "paused", period };
  const limit = positive(env.FORE_AUDIO_MONTHLY_SECONDS, 3600, 7200);
  const interval = Math.max(300, positive(env.FORE_AUDIO_MIN_INTERVAL_SECONDS, 86400, 2678400));
  if (limit < RESERVATION_SECONDS)
    return { allowed: false, reason: "monthly-budget", period, limit };
  const timestamp = at.toISOString();
  if (!reserve) {
    const row = await env.DB.prepare(
      "SELECT reserved_seconds,next_run_at FROM audio_compute_budgets WHERE period=?",
    )
      .bind(period)
      .first<{ reserved_seconds: number; next_run_at: string }>();
    const reason =
      row && row.reserved_seconds + RESERVATION_SECONDS > limit
        ? "monthly-budget"
        : row && row.next_run_at > timestamp
          ? "cooldown"
          : "available";
    return {
      allowed: reason === "available",
      reason,
      period,
      limit,
      reservedSeconds: row?.reserved_seconds || 0,
    };
  }
  const next = new Date(at.valueOf() + interval * 1000).toISOString();
  const saved = await env.DB.prepare(
    `INSERT INTO audio_compute_budgets(period,reserved_seconds,runs,next_run_at,updated_at)
     VALUES(?,300,1,?,?) ON CONFLICT(period) DO UPDATE SET
     reserved_seconds=audio_compute_budgets.reserved_seconds+300,
     runs=audio_compute_budgets.runs+1,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at
     WHERE audio_compute_budgets.reserved_seconds+300<=? AND audio_compute_budgets.next_run_at<=?
     RETURNING reserved_seconds,runs`,
  )
    .bind(period, next, timestamp, limit, timestamp)
    .first<{ reserved_seconds: number; runs: number }>();
  return {
    allowed: !!saved,
    reason: saved ? "reserved" : "budget-or-cooldown",
    period,
    limit,
    reservedSeconds: saved?.reserved_seconds,
    runs: saved?.runs,
  };
}
