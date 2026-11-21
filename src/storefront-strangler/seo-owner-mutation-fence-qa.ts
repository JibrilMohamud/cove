/**
 * ISOLATED QA PROTOTYPE ONLY. No production import, route or serving proof.
 * Observe ALL DML on the real owner's reviewed SQLite tables, including
 * negative AND positive transitions. Same-statement triggers close the gap
 * between a durable owner denial and a later primary-D1 reconciliation.
 *
 * A counter alone is not legal authority. This receipt is explicitly
 * nonauthorizing and incompatible with the production SEO proof schema.
 * No historical migration, KV authority, clock-expiry horizon or arbitrary
 * future owner schema is certified here. Never auto-repair a damaged fence.
 */
import type { AuthoritySql } from "./legal-authority-core";

export const QA_OWNER_MUTATION_SCHEMA = "cove.qa.owner-mutation-fence.v1";
export const QA_OWNER_MUTATION_TABLES = [
  "cove_authorized_offer_proofs",
  "cove_commercial_authority",
  "cove_commercial_retired_evidence",
  "cove_commercial_scope_proofs",
  "cove_commercial_storefront_proofs",
  "cove_commercial_subject_denial_ops",
  "cove_commercial_subject_denials",
  "cove_commercial_withdrawal_ops",
  "cove_legal_denial_operations",
  "cove_legal_fences",
  "cove_market_withdrawal_ops",
  "cove_market_withdrawals",
  "cove_owner_contract_version_commands",
  "cove_paid_entitlement_authority",
  "cove_paid_entitlement_ops",
  "cove_paid_entitlement_orders",
  "cove_paid_entitlement_scopes",
  "cove_paid_order_denial_ops",
  "cove_paid_refunded_orders",
  "cove_paid_settlement_commands",
  "cove_paid_settlement_recovery_cursors",
  "cove_publication_commands",
  "cove_publication_materializations",
  "cove_publication_recovery_scan",
] as const;

const FENCE = "cove_qa_owner_mutation_fence";
const MANIFEST = "cove_qa_owner_mutation_manifest";
const fenceDdl = `CREATE TABLE ${FENCE} (slot INTEGER PRIMARY KEY CHECK(slot=1), owner_version TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>=0 AND epoch<=9007199254740991))`;
const manifestDdl = `CREATE TABLE ${MANIFEST} (table_name TEXT PRIMARY KEY, table_sql TEXT NOT NULL) WITHOUT ROWID`;
const normalize = (s: string) => s.trim().replace(/;$/, "");
type Tx = <T>(fn: () => T) => T;
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };

function ownerVersion(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw Error("qa_owner_mutation_version_invalid");
  return value;
}
function schema(sql: AuthoritySql) {
  // __cf_kv is Cloudflare's hidden KV table. Its CONTENTS cannot be audited
  // through SQL; this prototype is restricted to SQL-only authority.
  return sql
    .exec<SchemaRow>(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view') ORDER BY name",
    )
    .toArray()
    .filter((r) => !r.name.startsWith("sqlite_") && r.name !== "__cf_kv");
}
function exactTables(rows: SchemaRow[], enrolled: boolean) {
  const expected = [...QA_OWNER_MUTATION_TABLES, ...(enrolled ? [FENCE, MANIFEST] : [])].sort();
  const actual = rows
    .filter((r) => r.type === "table")
    .map((r) => r.name)
    .sort();
  if (actual.join("\n") !== expected.join("\n") || rows.some((r) => r.type === "view"))
    throw Error("qa_owner_mutation_schema_unreviewed");
}
function triggerDdl(table: string, index: number, op: string, version: string) {
  const name = `qa_owner_mutation_${index}_${op.toLowerCase()}`;
  return {
    name,
    table,
    sql: `CREATE TRIGGER "${name}" AFTER ${op} ON "${table}" BEGIN
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${FENCE} WHERE slot=1 AND owner_version='${version}' AND typeof(epoch)='integer' AND epoch>=0 AND epoch<9007199254740991) THEN RAISE(ABORT,'qa_owner_mutation_fence_unavailable') END;
UPDATE ${FENCE} SET epoch=epoch+1 WHERE slot=1;
END`,
  };
}
function triggers(version: string) {
  const data = QA_OWNER_MUTATION_TABLES.flatMap((table, i) =>
    ["INSERT", "UPDATE", "DELETE"].map((op) => triggerDdl(table, i, op, version)),
  );
  return [
    ...data,
    {
      name: "qa_owner_fence_insert",
      table: FENCE,
      sql: `CREATE TRIGGER "qa_owner_fence_insert" BEFORE INSERT ON "${FENCE}" BEGIN SELECT RAISE(ABORT,'qa_owner_mutation_counter_immutable'); END`,
    },
    {
      name: "qa_owner_fence_update",
      table: FENCE,
      sql: `CREATE TRIGGER "qa_owner_fence_update" BEFORE UPDATE ON "${FENCE}" WHEN NEW.slot<>OLD.slot OR NEW.owner_version<>OLD.owner_version OR typeof(NEW.epoch)<>'integer' OR NEW.epoch<>OLD.epoch+1 BEGIN SELECT RAISE(ABORT,'qa_owner_mutation_counter_immutable'); END`,
    },
    {
      name: "qa_owner_fence_delete",
      table: FENCE,
      sql: `CREATE TRIGGER "qa_owner_fence_delete" BEFORE DELETE ON "${FENCE}" BEGIN SELECT RAISE(ABORT,'qa_owner_mutation_counter_immutable'); END`,
    },
    ...["INSERT", "UPDATE", "DELETE"].map((op) => ({
      name: "qa_owner_manifest_" + op.toLowerCase(),
      table: MANIFEST,
      sql: `CREATE TRIGGER "qa_owner_manifest_${op.toLowerCase()}" BEFORE ${op} ON "${MANIFEST}" BEGIN SELECT RAISE(ABORT,'qa_owner_mutation_manifest_immutable'); END`,
    })),
  ];
}
function checkedState(sql: AuthoritySql, version: string) {
  const rows = schema(sql);
  exactTables(rows, true);
  for (const [name, ddl] of [
    [FENCE, fenceDdl],
    [MANIFEST, manifestDdl],
  ]) {
    if (normalize(rows.find((r) => r.name === name)?.sql || "") !== ddl)
      throw Error("qa_owner_mutation_metadata_changed");
  }
  const saved = sql
    .exec<{ table_name: string; table_sql: string }>(
      `SELECT table_name,table_sql FROM ${MANIFEST} ORDER BY table_name`,
    )
    .toArray();
  if (saved.length !== QA_OWNER_MUTATION_TABLES.length)
    throw Error("qa_owner_mutation_manifest_incomplete");
  for (const [i, table] of QA_OWNER_MUTATION_TABLES.entries()) {
    const actual = rows.find((r) => r.type === "table" && r.name === table);
    if (saved[i]?.table_name !== table || saved[i]?.table_sql !== actual?.sql)
      throw Error("qa_owner_mutation_table_changed");
  }
  const expected = triggers(version);
  const actual = rows.filter((r) => r.type === "trigger");
  if (actual.length !== expected.length) throw Error("qa_owner_mutation_trigger_missing");
  for (const want of expected) {
    const got = actual.find((r) => r.name === want.name);
    if (got?.tbl_name !== want.table || normalize(got?.sql || "") !== want.sql)
      throw Error("qa_owner_mutation_trigger_changed");
  }
  const all = sql
    .exec<{ owner_version: string; epoch: number }>(`SELECT owner_version,epoch FROM ${FENCE}`)
    .toArray();
  const state = all[0];
  if (
    all.length !== 1 ||
    state?.owner_version !== version ||
    !Number.isSafeInteger(state.epoch) ||
    state.epoch < 0
  )
    throw Error("qa_owner_mutation_state_invalid");
  return state.epoch;
}

/** Only enroll a fresh SQL-only QA owner in one real transactionSync. */
export function enrollQaOwnerMutationFence(
  sql: AuthoritySql,
  transactionSync: Tx,
  version: string,
) {
  ownerVersion(version);
  return transactionSync(() => {
    const rows = schema(sql);
    const own = rows.filter((r) => r.name === FENCE || r.name === MANIFEST);
    if (own.length) {
      // A missing trigger may hide already committed legal changes. NEVER
      // recreate it, reset the epoch, or silently enroll an existing owner.
      return checkedState(sql, version);
    }
    exactTables(rows, false);
    if (rows.some((r) => r.type === "trigger"))
      throw Error("qa_owner_mutation_preexisting_trigger");
    for (const table of QA_OWNER_MUTATION_TABLES) {
      if (table === "cove_publication_recovery_scan") {
        const cursor = sql
          .exec<{ id: number; after_operation_id: string }>(
            "SELECT id,after_operation_id FROM cove_publication_recovery_scan",
          )
          .toArray();
        if (cursor.length !== 1 || cursor[0].id !== 1 || cursor[0].after_operation_id !== "")
          throw Error("qa_owner_mutation_nonvirgin");
      } else if (
        sql.exec<{ n: number }>(`SELECT COUNT(*) n FROM "${table}"`).toArray()[0]?.n !== 0
      ) {
        throw Error("qa_owner_mutation_nonvirgin");
      }
    }
    sql.exec(fenceDdl);
    sql.exec(manifestDdl);
    sql.exec(`INSERT INTO ${FENCE}(slot,owner_version,epoch) VALUES(1,?,0)`, version);
    for (const table of QA_OWNER_MUTATION_TABLES) {
      sql.exec(
        `INSERT INTO ${MANIFEST}(table_name,table_sql) VALUES(?,?)`,
        table,
        rows.find((r) => r.type === "table" && r.name === table)!.sql,
      );
    }
    for (const trigger of triggers(version)) sql.exec(trigger.sql);
    return checkedState(sql, version);
  });
}

/** Schema/trigger integrity and epoch are read in one owner transaction. */
export function readQaOwnerMutationFence(sql: AuthoritySql, transactionSync: Tx, version: string) {
  ownerVersion(version);
  const epoch = transactionSync(() => checkedState(sql, version));
  return {
    schema: QA_OWNER_MUTATION_SCHEMA,
    ownerVersion: version,
    mutationEpoch: String(epoch),
    authorizing: false as const,
    tables: QA_OWNER_MUTATION_TABLES.length,
    triggers: triggers(version).length,
  };
}
