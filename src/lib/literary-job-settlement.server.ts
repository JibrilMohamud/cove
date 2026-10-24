import type { CoveEnv } from "../features/fore/api.server";
import { literaryOutputReservationRefund } from "./literary-budget-settlement";

type D1 = CoveEnv["DB"];
const hex64 = /^[0-9a-f]{64}$/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export type IsolatedJobSettlement = {
  day: string;
  jobId: string;
  resultKey: string;
  resultSha256: string;
  leaseToken: string;
  promptCharacters: number;
  outputCharacters: number;
  reservedOutputCharacters: number;
};

/**
 * The unique job-ID receipt is committed by one SQL INSERT. Its AFTER INSERT
 * trigger debits the same CONTENT_DB daily ledger atomically. An ignored
 * duplicate never fires the trigger. A failed debit ABORTs the receipt insert.
 *
 * This is character-work quota credit, not a token or monetary cost refund.
 * The caller must first validate and publish exact SHA-verified R2 bytes.
 */
export async function settleIsolatedLiteraryJob(db: D1, args: IsolatedJobSettlement) {
  if (!isoDate.test(args.day) || !hex64.test(args.jobId) || !hex64.test(args.resultSha256))
    throw Error("invalid_isolated_literary_settlement_identity");
  if (
    args.resultKey !== "literary/isolated-inference-v1/" + args.jobId + ".json" ||
    !/^[0-9a-f-]{36}$/.test(args.leaseToken)
  )
    throw Error("invalid_isolated_literary_settlement_receipt");
  if (
    ![args.promptCharacters, args.outputCharacters, args.reservedOutputCharacters].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    )
  )
    throw Error("invalid_isolated_literary_settlement_units");
  const refund = literaryOutputReservationRefund(
    args.promptCharacters,
    args.outputCharacters,
    args.reservedOutputCharacters,
  );
  const now = new Date().toISOString();
  // Verify the current secondary lease, active budget day, and uncontaminated
  // domain in the same SQL statement that creates the immutable receipt.
  const committed = await db
    .prepare(
      "INSERT OR IGNORE INTO literary_job_output_settlements" +
        " (job_id,day,result_key,result_sha256,prompt_characters,output_characters," +
        " reserved_output_characters,refund_units,applied,created_at)" +
        " SELECT ?,?,?,?,?,?,?,?,1,?" +
        " WHERE EXISTS(SELECT 1 FROM literary_inference_jobs" +
        " WHERE id=? AND status='running' AND lease_token=? AND lease_until>?)" +
        " AND EXISTS(SELECT 1 FROM literary_budget_domain_identity" +
        " WHERE id=1 AND domain='cove-isolated-literary-budget' AND schema_version=1)" +
        " AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table'" +
        " AND name IN ('rights_grants','products','payment_orders'))" +
        " AND EXISTS(SELECT 1 FROM literary_budget_cutover" +
        " WHERE day=? AND status='active')" +
        " RETURNING job_id",
    )
    .bind(
      args.jobId,
      args.day,
      args.resultKey,
      args.resultSha256,
      args.promptCharacters,
      args.outputCharacters,
      args.reservedOutputCharacters,
      refund,
      now,
      args.jobId,
      args.leaseToken,
      now,
      args.day,
    )
    .first<{ job_id: string }>();
  return { refunded: committed ? refund : 0, committed: !!committed };
}

/** Only explicitly returned provider usage counts are accepted as factual. */
export function observedLiteraryAiUsage(raw: unknown) {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const meta =
    value.meta && typeof value.meta === "object"
      ? (value.meta as Record<string, unknown>)
      : {};
  const usageRaw = value.usage ?? meta.usage;
  const usage =
    usageRaw && typeof usageRaw === "object" ? (usageRaw as Record<string, unknown>) : {};
  const integer = (...names: string[]) => {
    for (const name of names) {
      const n = usage[name];
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
    }
    return null;
  };
  const nonnegative = (...names: string[]) => {
    for (const name of names) {
      const n = usage[name];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  };
  return {
    inputTokens: integer("input_tokens", "prompt_tokens"),
    outputTokens: integer("output_tokens", "completion_tokens"),
    billedNeurons: nonnegative("billed_neurons", "neurons"),
    providerCostUsd: nonnegative("cost_usd"),
  };
}

/**
 * One row per actual AI invocation, including retries; no prompts or generated
 * text. NULL provider values are unreported, never estimated from characters.
 * Failures are handled by callers so telemetry never blocks valid inference.
 */
export async function recordLiteraryAiInvocation(
  db: D1,
  jobId: string,
  model: string,
  response: unknown,
) {
  if (!hex64.test(jobId) || model.length < 1 || model.length > 180)
    throw Error("invalid_literary_ai_usage_identity");
  const usage = observedLiteraryAiUsage(response);
  await db
    .prepare(
      "INSERT INTO literary_ai_invocation_usage" +
        " (invocation_id,job_id,model_id,observed_at,input_tokens,output_tokens," +
        " billed_neurons,provider_cost_usd) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      crypto.randomUUID(),
      jobId,
      model,
      new Date().toISOString(),
      usage.inputTokens,
      usage.outputTokens,
      usage.billedNeurons,
      usage.providerCostUsd,
    )
    .run();
  return usage;
}
