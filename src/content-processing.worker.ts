import { runStoredAssetTick } from "./features/fore/catalog-assets.server";
import { runLiteraryProfileTick } from "./features/fore/literary-profiles.server";
import { runIsolatedLiteraryPreparationTick } from "./lib/literary-preparation-domain.server";
import { dispatchOneLiteraryPreparationHandoff } from "./lib/literary-prepare-outbox.server";
import { admitCatalogBatch, catalogAdmissionBudget } from "./lib/catalog-ingestion-backpressure";
import type { CoveEnv } from "./features/fore/api.server";

/**
 * Independently deployable scheduled runtime for CPU/AI-heavy content jobs.
 * Disabling the old cron and enabling this Worker must be a staged cutover.
 *
 * This separates Worker initialization, CPU and execution limits. It does NOT
 * isolate the primary D1 writer: externalizing D1 storage remains necessary
 * and is deliberately not represented as completed here.
 */
export type ContentProcessorEnv = CoveEnv & {
  FORE_CONTENT_PROCESSOR_ENABLED?: string;
  FORE_CONTENT_PROCESSOR_ROLE?: "assets" | "literary" | "literary-prepare" | "literary-handoff";
  FORE_CONTENT_D1_ADMISSION_MAX_MS?: string;
  FORE_ASSETS_PER_MINUTE?: string;
  FORE_CONTENT_PREPARE_ENABLED?: string;
  FORE_CONTENT_HANDOFF_ENABLED?: string;
  CONTENT_DB?: CoveEnv["DB"];
  FORE_CONTENT_BUDGET_MODE?: string;
};

type Runner = (env: ContentProcessorEnv) => Promise<unknown>;
type ProcessorRunners = {
  assets: Runner;
  literary: Runner;
  "literary-prepare"?: Runner;
  "literary-handoff"?: Runner;
};
/** Keep per-minute background writes bounded even if dashboard configuration
 * is accidentally raised. These caps do not affect the original Worker. */
export const CONTENT_MAX_ASSET_ATTEMPTS_PER_TICK = 4;
export const CONTENT_LITERARY_TICK_CAPS = Object.freeze({
  maxSeeds: 8,
  maxPrepares: 1,
  maxDeferredSections: 1,
  maxInferences: 1,
});
export function contentAssetAttemptCap(value: unknown): number {
  const parsed = value === undefined ? 1 : Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(0, Math.min(CONTENT_MAX_ASSET_ATTEMPTS_PER_TICK, parsed))
    : 0;
}
const defaultRunners: ProcessorRunners = {
  assets: (env) =>
    runStoredAssetTick({
      ...env,
      FORE_ASSETS_PER_MINUTE: String(contentAssetAttemptCap(env.FORE_ASSETS_PER_MINUTE)),
    }),
  literary: (env) => runLiteraryProfileTick(env, CONTENT_LITERARY_TICK_CAPS),
  "literary-prepare": (env) => runIsolatedLiteraryPreparationTick(env),
  "literary-handoff": (env) => dispatchOneLiteraryPreparationHandoff(env),
};

export async function runContentProcessingTick(
  env: ContentProcessorEnv,
  runners: ProcessorRunners = defaultRunners,
) {
  if (env.FORE_CONTENT_PROCESSOR_ENABLED !== "1") return { skipped: "disabled" };
  const role = env.FORE_CONTENT_PROCESSOR_ROLE;
  if (
    role !== "assets" &&
    role !== "literary" &&
    role !== "literary-prepare" &&
    role !== "literary-handoff"
  ) return { skipped: "invalid_role" };
  if (role === "literary-prepare" && env.FORE_CONTENT_PREPARE_ENABLED !== "1")
    return { skipped: "preparation_disabled" };
  if (role === "literary-handoff" && (
    env.FORE_CONTENT_PREPARE_ENABLED !== "1" ||
    env.FORE_CONTENT_HANDOFF_ENABLED !== "1"
  )) return { skipped: "handoff_disabled" };
  if (!env.BUCKET) return { skipped: "missing_private_r2", role };
  if (role === "literary" && !env.AI) return { skipped: "missing_ai", role };

  // At most one read-only D1 latency probe per cron execution. If rights and
  // commerce requests are already experiencing database queueing, derived
  // content work should not begin another write-heavy batch.
  const budget = catalogAdmissionBudget(env.FORE_CONTENT_D1_ADMISSION_MAX_MS);
  const admission = await admitCatalogBatch(env.DB, budget);
  if (!admission.allowed) {
    console.warn(
      JSON.stringify({
        event: "content_processing_deferred",
        role,
        reason: admission.reason,
        probeMs: admission.probeMs,
      }),
    );
    return { skipped: admission.reason, role, probeMs: admission.probeMs };
  }
  const started = performance.now();
  const runner = runners[role];
  if (!runner) return { skipped: "missing_runner", role };
  const result = await runner(env);
  const elapsedMs = Math.ceil(performance.now() - started);
  console.info(
    JSON.stringify({
      event: "content_processing_tick",
      role,
      elapsedMs,
      result,
    }),
  );
  return { role, result, elapsedMs };
}

export default {
  async scheduled(
    _controller: { cron: string },
    env: ContentProcessorEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    ctx.waitUntil(
      runContentProcessingTick(env).catch((error) => {
        console.error(
          JSON.stringify({
            event: "content_processing_failure",
            role: env.FORE_CONTENT_PROCESSOR_ROLE || "unknown",
            reason: String(error).slice(0, 180),
          }),
        );
        throw error;
      }),
    );
  },
  async fetch() {
    // Content processors have NO remotely triggerable mutation endpoints.
    return new Response("Not found", { status: 404 });
  },
};
