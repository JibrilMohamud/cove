/**
 * Source-only Durable Object denial-epoch contract. NOT imported by the
 * production legal-authority worker until every deny-first command is covered.
 *
 * Every relevant legal denial MUST increment this owner-wide epoch in the
 * SAME DO storage.transactionSync as its own durable deny. A response must
 * never acknowledge a deny before both commits succeed. A D1 trigger/ack
 * cannot stand in for this stronger owner first boundary.
 */
export const SEO_OWNER_DENIAL_SCHEMA = "cove.seo.owner-denial-epoch.v1";
export const SEO_OWNER_DENIAL_ROUTE = "/seo/denial-epoch";
export const SEO_OWNER_DENIAL_AUTHORITY = "canonical-legal-durable-object";
type Sql = {
  exec<T = Record<string, unknown>>(
    statement: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] };
};
type OwnerEpoch = { epoch: number };

export function createSeoOwnerDenialEpochSchema(sql: Sql) {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_seo_owner_denial_epoch (" +
      "slot INTEGER PRIMARY KEY CHECK(slot=1)," +
      "epoch INTEGER NOT NULL CHECK(epoch>=0))",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_seo_owner_denial_events (" +
      "operation_id TEXT PRIMARY KEY," +
      "epoch INTEGER NOT NULL CHECK(epoch>0))",
  );
  sql.exec("INSERT OR IGNORE INTO cove_seo_owner_denial_epoch(slot,epoch) VALUES(1,0)");
}
export function readSeoOwnerDenialEpoch(sql: Sql): number {
  const state = sql
    .exec<OwnerEpoch>("SELECT epoch FROM cove_seo_owner_denial_epoch WHERE slot=1")
    .toArray()[0];
  if (!state || !Number.isSafeInteger(state.epoch) || state.epoch < 0)
    throw Error("seo_owner_denial_epoch_unavailable");
  return state.epoch;
}
export type SeoDenialEpochReceipt = {
  applied: boolean;
  replayed: boolean;
  epoch: number | null;
};
/**
 * The mutateDenial callback MUST be a vetted canonical owner denial. No
 * network await is allowed while the owner's SQLite transaction is open.
 * Duplicate acknowledged operations do not advance the epoch twice.
 * A replay MUST be checked against the CURRENT canonical legal-denial state
 * before any mutator runs. The verifier must bind this operation ID to the
 * same scope, revision and still-active denial, not merely any active denial.
 * Replaying after a superseding allow MUST fail without reapplying a denial.
 */
export function withSeoOwnerDenialEpoch(
  sql: Sql,
  operationId: string,
  transactionSync: <T>(fn: () => T) => T,
  mutateDenial: () => { applied: boolean },
  isOperationDenialCurrent: () => boolean,
): SeoDenialEpochReceipt {
  if (typeof isOperationDenialCurrent !== "function")
    throw Error("seo_owner_denial_verifier_required");
  if (typeof operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(operationId))
    throw Error("seo_owner_denial_operation_invalid");
  return transactionSync(() => {
    // Inspect the idempotency key BEFORE running any canonical deny mutation.
    // Otherwise a replay after a superseding allow could silently re-deny.
    const prior = sql
      .exec<OwnerEpoch>(
        "SELECT epoch FROM cove_seo_owner_denial_events WHERE operation_id=?",
        operationId,
      )
      .toArray()[0];
    if (prior) {
      if (!Number.isSafeInteger(prior.epoch) || prior.epoch < 1)
        throw Error("seo_owner_denial_event_corrupt");
      if (isOperationDenialCurrent() !== true) throw Error("seo_owner_denial_replay_not_current");
      return { applied: true, replayed: true, epoch: prior.epoch };
    }
    const result = mutateDenial();
    if (!result || result.applied !== true || isOperationDenialCurrent() !== true)
      throw Error("seo_owner_denial_not_durable");
    const value = readSeoOwnerDenialEpoch(sql);
    if (value >= Number.MAX_SAFE_INTEGER - 1) throw Error("seo_owner_denial_epoch_exhausted");
    const next = sql
      .exec<OwnerEpoch>(
        "UPDATE cove_seo_owner_denial_epoch SET epoch=epoch+1 WHERE slot=1 RETURNING epoch",
      )
      .toArray()[0]?.epoch;
    if (next !== value + 1) throw Error("seo_owner_denial_epoch_write_failed");
    sql.exec(
      "INSERT INTO cove_seo_owner_denial_events(operation_id,epoch) VALUES(?,?)",
      operationId,
      next,
    );
    return { applied: true, replayed: false, epoch: next };
  });
}

/** Only create this proof while handling an authenticated private owner route.
 * The route MUST be unreachable when the owner is disabled or QA lease ended.
 * A private reader must challenge-bind it (see seo-owner-denial-read.server.ts).
 */
export function seoOwnerDenialProof(sql: Sql, ownerVersion: string, challenge: string) {
  if (
    typeof ownerVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerVersion) ||
    typeof challenge !== "string" ||
    !/^[a-f0-9]{32}$/.test(challenge)
  )
    throw Error("seo_owner_denial_proof_invalid");
  return {
    schema: SEO_OWNER_DENIAL_SCHEMA,
    authority: SEO_OWNER_DENIAL_AUTHORITY,
    ownerVersion,
    denialEpoch: String(readSeoOwnerDenialEpoch(sql)),
    challenge,
  };
}
