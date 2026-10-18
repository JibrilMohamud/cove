/**
 * Cooperative admission for bulk, retryable catalogue ingestion ONLY.
 *
 * D1 uses a serialized writer. Starting another nonauthoritative search
 * projection rebuild when its primary service is already backed up can
 * amplify latency for customer-facing rights reads. A busy/unavailable
 * primary defers ONLY this derived index to the next cron tick. The catalog
 * metadata and regional rights/evidence import MUST NOT be gated here.
 * Customer reads, revocations, erasure, commerce and delivery are unaffected.
 */
export type CatalogAdmissionDB = {
  prepare(sql: string): { first<T>(): Promise<T | null> };
};
export type CatalogAdmission = {
  allowed: boolean;
  reason: "healthy" | "primary_busy" | "primary_unavailable";
  probeMs: number;
};
export function catalogAdmissionBudget(value: unknown): number {
  const requested = Number(value);
  return Number.isFinite(requested) && requested > 0
    ? Math.max(100, Math.min(1000, Math.round(requested)))
    : 300;
}

export async function admitCatalogBatch(
  db: CatalogAdmissionDB,
  budgetMs = 300,
  clock: () => number = () => performance.now(),
): Promise<CatalogAdmission> {
  const limit = catalogAdmissionBudget(budgetMs);
  const begin = clock();
  try {
    const row = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    const probeMs = Math.max(0, Math.ceil(clock() - begin));
    if (row?.ok !== 1) return { allowed: false, reason: "primary_unavailable", probeMs };
    return {
      allowed: probeMs <= limit,
      reason: probeMs <= limit ? "healthy" : "primary_busy",
      probeMs,
    };
  } catch {
    return {
      allowed: false,
      reason: "primary_unavailable",
      probeMs: Math.max(0, Math.ceil(clock() - begin)),
    };
  }
}
