/**
 * Isolated QA-only bridge from the REAL canonical source-denial DO command to
 * the draft SEO owner-denial epoch journal. This is deliberately NOT the
 * production proof route and cannot be used to serve sitemaps.
 *
 * QA is restricted to a virgin legal source owner: importing a historical
 * owner as epoch 0 would incorrectly certify earlier withdrawals.
 */
import {
  createAuthoritySchema,
  persistSourceWithdrawal,
  readAuthority,
  validateAuthorityCommand,
  type AuthoritySql,
} from "./legal-authority-core";
import { createSeoOwnerDenialEpochSchema, withSeoOwnerDenialEpoch } from "./seo-owner-denial-epoch";

type OwnerTransaction = <T>(fn: () => T) => T;
type DenialOperation = { sourceId: string; territory: string; operationId: string };
type OperationRow = { source_id: string; territory: string; revision: number };
type FenceRow = { revision: number; verdict: string };

function validateOperation(raw: unknown): DenialOperation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Error("seo_qa_denial_operation_invalid");
  }
  const input = raw as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(",") !== "operationId,sourceId,territory" ||
    typeof input.operationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.operationId) ||
    typeof input.sourceId !== "string" ||
    typeof input.territory !== "string"
  )
    throw Error("seo_qa_denial_operation_invalid");
  validateAuthorityCommand({
    sourceId: input.sourceId,
    territory: input.territory,
    revision: 1,
    action: "deny",
  });
  return input as DenialOperation;
}

function operationRow(sql: AuthoritySql, input: DenialOperation): OperationRow | null {
  const row = sql
    .exec<OperationRow>(
      "SELECT source_id,territory,revision FROM cove_legal_denial_operations WHERE operation_id=?",
      input.operationId,
    )
    .toArray()[0];
  if (
    !row ||
    row.source_id !== input.sourceId ||
    row.territory !== input.territory ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  )
    return null;
  return row;
}

/** Exact operation + still-current canonical revision, NOT merely a deny somewhere. */
export function qaSourceDenialCurrent(sql: AuthoritySql, input: DenialOperation): boolean {
  const row = operationRow(sql, input);
  if (!row) return false;
  const fence = sql
    .exec<FenceRow>(
      "SELECT revision,verdict FROM cove_legal_fences WHERE source_id=? AND territory=?",
      input.sourceId,
      input.territory,
    )
    .toArray()[0];
  if (fence?.verdict !== "deny" || fence.revision !== row.revision) return false;
  const state = readAuthority(
    sql,
    input.sourceId,
    input.territory === "*" ? "US" : input.territory,
  );
  if (state.allowed || state.revision !== row.revision) return false;
  if (input.territory === "*") {
    // A newer US/other-country allowance supersedes an old global withdrawal
    // even when a different country's effective verdict remains denied.
    const superseded = sql
      .exec<{ one: number }>(
        "SELECT 1 one FROM cove_legal_fences WHERE source_id=? AND revision>? AND verdict='allow' LIMIT 1",
        input.sourceId,
        row.revision,
      )
      .toArray()[0];
    if (superseded) return false;
  }
  return true;
}

function requireVirginQaBootstrap(sql: AuthoritySql) {
  const names = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cove_seo_owner_denial_epoch','cove_seo_owner_denial_events')",
    )
    .toArray();
  if (names.length === 2) return;
  if (names.length !== 0) throw Error("seo_qa_partial_epoch_schema");
  // Source-law state and operation history must both be EMPTY on first
  // enrollment. All other denial families remain blocked in QA shadow mode.
  createAuthoritySchema(sql);
  const fences = sql
    .exec<{ n: number }>("SELECT COUNT(*) n FROM cove_legal_fences")
    .toArray()[0]?.n;
  const operations = sql
    .exec<{ n: number }>("SELECT COUNT(*) n FROM cove_legal_denial_operations")
    .toArray()[0]?.n;
  if (fences !== 0 || operations !== 0) throw Error("seo_qa_epoch_nonvirgin");
  createSeoOwnerDenialEpochSchema(sql);
}

/**
 * Called only behind qaOwnerLeaseLive + a separate opt-in shadow flag.
 * All other owner denial/grant routes MUST be unavailable in that mode.
 * No private SEO proof endpoint is offered and no production caller uses it.
 */
export function withSeoQaSourceDenialEpoch(
  sql: AuthoritySql,
  transactionSync: OwnerTransaction,
  raw: unknown,
) {
  const input = validateOperation(raw);
  return transactionSync(() => {
    // Bootstrap and the first legal mutation commit together, or neither.
    requireVirginQaBootstrap(sql);
    // The outer owner transaction encloses the wrapper's nested callback.
    // Passing a direct executor here is safe only because this function is
    // itself enclosed in a REAL caller-owned transactionSync.
    const epoch = withSeoOwnerDenialEpoch(
      sql,
      input.operationId,
      <T>(fn: () => T): T => fn(),
      () => persistSourceWithdrawal(sql, input),
      () => qaSourceDenialCurrent(sql, input),
    );
    const row = operationRow(sql, input);
    if (!row || !qaSourceDenialCurrent(sql, input))
      throw Error("seo_qa_denial_receipt_not_current");
    return {
      applied: true,
      revision: row.revision,
      state: readAuthority(sql, input.sourceId, input.territory === "*" ? "US" : input.territory),
      ownerDenialEpoch: epoch.epoch,
      replayed: epoch.replayed,
    };
  });
}
