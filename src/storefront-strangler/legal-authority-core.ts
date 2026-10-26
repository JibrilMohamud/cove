/* eslint-disable prettier/prettier -- Monotonic legal state is intentionally auditable. */
/**
 * Single-owner, SQLite-backed denial fence. This is NOT a grant database.
 * All positive publication is contingent on a separate fresh-primary proof
 * and full canonical writer closure; missing rows always deny.
 */
export type AuthoritySql = {
  exec<T = Record<string, unknown>>(query: string, ...bindings: (string|number|null)[]): {
    toArray(): T[];
  };
};
export type AuthorityCommand = {
  sourceId: string;
  territory: string;
  revision: number;
  action: "deny" | "allow";
};
export function validateAuthorityCommand(raw: unknown): AuthorityCommand {
  if (!raw || typeof raw !== "object") throw Error("invalid_authority_command");
  const input = raw as Record<string, unknown>;
  if (typeof input.sourceId !== "string" ||
      !/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/.test(input.sourceId) ||
      typeof input.territory !== "string" ||
      !/^(?:[A-Z]{2}|\*)$/.test(input.territory) ||
      !Number.isSafeInteger(input.revision) || (input.revision as number) <= 0 ||
      (input.action !== "deny" && input.action !== "allow") ||
      (input.action === "allow" && input.territory === "*"))
    throw Error("invalid_authority_command");
  return input as AuthorityCommand;
}
export function createAuthoritySchema(sql: AuthoritySql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_legal_fences (
    source_id TEXT NOT NULL,
    territory TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    verdict TEXT NOT NULL CHECK(verdict IN ('deny','allow')),
    PRIMARY KEY(source_id,territory)
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_legal_denial_operations(
    operation_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    territory TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0)
  ) WITHOUT ROWID`);
}
type FenceRow = { revision: number; verdict: "deny" | "allow"; territory: string };
export function readAuthority(sql: AuthoritySql, sourceId: string, territory: string) {
  if (!/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/.test(sourceId) ||
    !/^[A-Z]{2}$/.test(territory)) throw Error("invalid_authority_scope");
  const rows=sql.exec<FenceRow>(
    "SELECT revision,verdict,territory FROM cove_legal_fences WHERE source_id=? AND territory IN (?,'*') ORDER BY revision DESC, CASE WHEN verdict='deny' THEN 0 ELSE 1 END LIMIT 1",
    sourceId,territory
  ).toArray();
  const state=rows[0];
  return { allowed: state?.verdict === "allow", revision: state?.revision ?? null };
}

/**
 * Positive proof storage is not a cache of untrusted presentation fields.
 * Proofs are keyed to the exact rights revision, verified country, currency,
 * edition identity and canonical retail offer. Denial disables old proofs
 * without asynchronous cache invalidation.
 */
export type VerifiedOfferProof = {
  productId: string;
  editionId: string;
  productPublicId: string | null;
  editionPublicId: string | null;
  offerJson: string;
};
export function validateVerifiedOfferProof(
  command: AuthorityCommand, currency: string, proof: VerifiedOfferProof
) {
  if (command.action !== "allow" || command.territory === "*" ||
      !/^[A-Z]{3}$/.test(currency) ||
      !proof || proof.productId !== "prd_gutenberg_" + command.sourceId ||
      proof.editionId !== "ed_gutenberg_" + command.sourceId ||
      (proof.productPublicId !== null &&
        (typeof proof.productPublicId !== "string" || proof.productPublicId.length > 160)) ||
      (proof.editionPublicId !== null &&
        (typeof proof.editionPublicId !== "string" || proof.editionPublicId.length > 160)) ||
      typeof proof.offerJson !== "string" || proof.offerJson.length > 512)
    throw Error("invalid_authority_offer");
  let offer: unknown;
  try { offer = JSON.parse(proof.offerJson); }
  catch { throw Error("invalid_authority_offer"); }
  // The initial independent authority supports only free public-domain
  // Gutenberg grants. Paid/subscription offers require separate entitlement
  // and money invariants and MUST continue consulting the live primary.
  const record = offer as Record<string, unknown> | null;
  if (!record || Array.isArray(record) || record.type !== "public-domain" ||
      record.currency !== currency || record.amountMinor !== 0 ||
      Object.keys(record).sort().join(",") !== "amountMinor,currency,type")
    throw Error("invalid_authority_offer");
}
export function createAuthorityProofSchema(sql: AuthoritySql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_authorized_offer_proofs(
    source_id TEXT NOT NULL, territory TEXT NOT NULL, currency TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    product_id TEXT NOT NULL, edition_id TEXT NOT NULL,
    product_public_id TEXT, edition_public_id TEXT,
    offer_json TEXT NOT NULL,
    PRIMARY KEY(source_id, territory, currency)
  ) WITHOUT ROWID`);
}
export function storeAuthorizedPresentationProof(
  sql: AuthoritySql, raw: unknown, currency: string, proof: VerifiedOfferProof
) {
  const command = validateAuthorityCommand(raw);
  validateVerifiedOfferProof(command,currency,proof);
  const decision = readAuthority(sql,command.sourceId,command.territory);
  if (!decision.allowed || decision.revision !== command.revision)
    throw Error("authority_positive_revision_unconfirmed");
  // Only the current exact rev may expose an offer. A stale publication may
  // never overwrite the latest proof, even if both are positive.
  sql.exec(`INSERT INTO cove_authorized_offer_proofs(
    source_id,territory,currency,revision,product_id,edition_id,
    product_public_id,edition_public_id,offer_json
  ) VALUES(?,?,?,?,?,?,?,?,?)
  ON CONFLICT(source_id,territory,currency) DO UPDATE SET
    revision=excluded.revision, product_id=excluded.product_id,
    edition_id=excluded.edition_id,product_public_id=excluded.product_public_id,
    edition_public_id=excluded.edition_public_id,offer_json=excluded.offer_json
  WHERE excluded.revision >= cove_authorized_offer_proofs.revision`,
    command.sourceId,command.territory,currency,command.revision,
    proof.productId,proof.editionId,proof.productPublicId,proof.editionPublicId,proof.offerJson);
  return readAuthority(sql,command.sourceId,command.territory);
}
export type AuthorityPresentationRow = {
  product_id:string; edition_id:string; product_public_id:string|null;
  edition_public_id:string|null; offer_json:string;
};
export function readAuthorizedPresentations(
  sql: AuthoritySql, ids: string[], territory:string, currency:string
):AuthorityPresentationRow[] {
  if (!Array.isArray(ids) || ids.length>128 ||
      !/^[A-Z]{2}$/.test(territory) || !/^[A-Z]{3}$/.test(currency) ||
      ids.some(id=>typeof id!=="string" ||
        !/^prd_gutenberg_(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/.test(id)) ||
      new Set(ids).size!==ids.length) throw Error("invalid_authority_batch");
  if (!ids.length) return [];
  // One strongly consistent SQL read per request, not 128 subrequests:
  // revocations are committed before acknowledgment and no replica or KV
  // allowance is consulted. The revision equality invalidates old offers.
  // Equal-revision global DENY outranks a local allow.
  return sql.exec<AuthorityPresentationRow>(
    `SELECT p.product_id,p.edition_id,p.product_public_id,
            p.edition_public_id,p.offer_json
     FROM json_each(?) candidate
     JOIN cove_authorized_offer_proofs p
       ON p.product_id=candidate.value AND p.territory=? AND p.currency=?
     WHERE (
       SELECT f.verdict FROM cove_legal_fences f
       WHERE f.source_id=p.source_id AND f.territory IN (?,'*')
       ORDER BY f.revision DESC,
         CASE WHEN f.verdict='deny' THEN 0 ELSE 1 END LIMIT 1
     )='allow'
     AND p.revision=(
       SELECT f.revision FROM cove_legal_fences f
       WHERE f.source_id=p.source_id AND f.territory IN (?,'*')
       ORDER BY f.revision DESC,
         CASE WHEN f.verdict='deny' THEN 0 ELSE 1 END LIMIT 1
     )
     ORDER BY CAST(candidate.key AS INTEGER) LIMIT 25`,
    JSON.stringify(ids),territory,currency,territory,territory
  ).toArray();
}


/**
 * Allocate a durable, source-wide monotonic revision for a withdrawal.
 * The idempotency key comes from the canonical writer event identity. Never
 * allow an older feed seq or a client wall clock to be used as authority.
 *
 * Writes are performed synchronously without a network await. Fence FIRST,
 * receipt SECOND: a crash between them errs toward another denial, never a
 * positive grant or a false acknowledgement.
 */
export function persistSourceWithdrawal(sql:AuthoritySql,raw:unknown){
  if(!raw||typeof raw!=="object") throw Error("invalid_denial_operation");
  const item=raw as Record<string,unknown>;
  const {sourceId,territory,operationId}=item;
  if(typeof sourceId!=="string"||typeof territory!=="string"||
      typeof operationId!=="string"||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(operationId))
    throw Error("invalid_denial_operation");
  validateAuthorityCommand({sourceId,territory,revision:1,action:"deny"});
  const existing=sql.exec<{source_id:string;territory:string;revision:number}>(
    "SELECT source_id,territory,revision FROM cove_legal_denial_operations WHERE operation_id=?",
    operationId
  ).toArray()[0];
  if(existing){
    if(existing.source_id!==sourceId||existing.territory!==territory)
      throw Error("denial_operation_reused_with_different_scope");
    const current=readAuthority(sql,sourceId,territory==="*"?"US":territory);
    const regrantedAfterGlobalWithdrawal=territory==="*" &&
      sql.exec<{one:number}>(
        "SELECT 1 one FROM cove_legal_fences WHERE source_id=? AND revision>? AND verdict='allow' LIMIT 1",
        sourceId,existing.revision
      ).toArray().length>0;
    return {applied:!current.allowed && !regrantedAfterGlobalWithdrawal &&
      current.revision!==null && current.revision>=existing.revision,
      revision:existing.revision,state:current};
  }
  const highest=sql.exec<{max_revision:number|null}>(
    "SELECT MAX(revision) max_revision FROM cove_legal_fences WHERE source_id=?",
    sourceId
  ).toArray()[0]?.max_revision ?? 0;
  if(!Number.isSafeInteger(highest)||highest<0||
      highest>=Number.MAX_SAFE_INTEGER-1) throw Error("legal_revision_exhausted");
  const revision=highest+1;
  const result=applyAuthorityCommand(sql,{sourceId,territory,revision,action:"deny"});
  if(!result.applied) throw Error("denial_not_persisted");
  sql.exec(
    "INSERT INTO cove_legal_denial_operations(operation_id,source_id,territory,revision) VALUES(?,?,?,?)",
    operationId,sourceId,territory,revision
  );
  return {applied:true,revision,state:result.state};
}

export function applyAuthorityCommand(sql: AuthoritySql, raw: unknown) {
  const c=validateAuthorityCommand(raw);
  if (c.territory==="*") {
    // A source-wide denial must outrank every previously acknowledged
    // territory state, not just the existing wildcard row. A writer with
    // a stale global revision is rejected and may not mutate primary rights.
    const highest=sql.exec<{max_revision:number|null}>(
      "SELECT MAX(revision) max_revision FROM cove_legal_fences WHERE source_id=?",
      c.sourceId
    ).toArray()[0]?.max_revision ?? 0;
    const existing=sql.exec<FenceRow>(
      "SELECT revision,verdict,territory FROM cove_legal_fences WHERE source_id=? AND territory='*'",
      c.sourceId
    ).toArray()[0];
    const replay=existing?.revision===c.revision && existing.verdict==="deny" &&
      c.revision===highest;
    if(highest >= c.revision && !replay)
      return { applied:false, state:readAuthority(sql,c.sourceId,"US") };
  }
  // Only a strictly newer revision can change the verdict. At equal
  // revision DENY wins; an equal/stale ALLOW can never reinstate rights.
  sql.exec(`INSERT INTO cove_legal_fences(source_id,territory,revision,verdict)
    VALUES(?,?,?,?)
    ON CONFLICT(source_id,territory) DO UPDATE
    SET revision=excluded.revision,verdict=excluded.verdict
    WHERE excluded.revision>cove_legal_fences.revision
       OR (excluded.revision=cove_legal_fences.revision
         AND excluded.verdict='deny' AND cove_legal_fences.verdict<>'deny')`,
    c.sourceId,c.territory,c.revision,c.action
  );
  const state=sql.exec<FenceRow>(
    "SELECT revision,verdict,territory FROM cove_legal_fences WHERE source_id=? AND territory=?",
    c.sourceId,c.territory
  ).toArray()[0];
  if (!state) throw Error("authority_write_not_durable");
  const effective=readAuthority(sql,c.sourceId,c.territory==="*"?"US":c.territory);
  const applied=state.revision===c.revision && state.verdict===c.action &&
    (c.action!=="allow" || effective.allowed);
  return { applied, state: effective };
}
