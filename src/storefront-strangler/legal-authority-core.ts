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
      !/^(?:[A-Z]{2}|\\*)$/.test(input.territory) ||
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
export function applyAuthorityCommand(sql: AuthoritySql, raw: unknown) {
  const c=validateAuthorityCommand(raw);
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
  const applied=state.revision===c.revision &&
    state.verdict===c.action;
  return { applied, state: readAuthority(sql,c.sourceId,c.territory==="*"?"US":c.territory) };
}
