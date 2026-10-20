import { runStoredAssetTick } from "./features/fore/catalog-assets.server";
import { runLiteraryProfileTick } from "./features/fore/literary-profiles.server";
import {
  admitCatalogBatch,
  catalogAdmissionBudget,
} from "./lib/catalog-ingestion-backpressure";
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
  FORE_CONTENT_PROCESSOR_ROLE?: "assets" | "literary";
  FORE_CONTENT_D1_ADMISSION_MAX_MS?: string;
  FORE_ASSETS_PER_MINUTE?: string;
};

type Runner = (env: ContentProcessorEnv) => Promise<unknown>;
type ProcessorRunners = {
  assets: Runner;
  literary: Runner;
};
const defaultRunners: ProcessorRunners = {
  assets: runStoredAssetTick,
  literary: runLiteraryProfileTick,
};

export async function runContentProcessingTick(
  env: ContentProcessorEnv,
  runners: ProcessorRunners = defaultRunners,
) {
  if (env.FORE_CONTENT_PROCESSOR_ENABLED !== "1")
    return { skipped: "disabled" };
  const role = env.FORE_CONTENT_PROCESSOR_ROLE;
  if (role !== "assets" && role !== "literary")
    return { skipped: "invalid_role" };
  if (!env.BUCKET)
    return { skipped: "missing_private_r2", role };
  if (role === "literary" && !env.AI)
    return { skipped: "missing_ai", role };

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
  const result = await runners[role](env);
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
