/**
 * QA-only transition seam: a backend with NO native D1 binding may obtain
 * SELECT-only access through the privately leased canonical owner.
 *
 * Production is explicitly forbidden. This is not an owner write command,
 * owner authorization, sticky D1 session or permission to change a cron.
 * No feature flag may bypass the absence-of-DB-binding requirement.
 */
import type { CoveEnv } from "../features/fore/api.server";
import { createQaOwnerReadOnlyD1 } from "./qa-owner-primary-read-transport.mjs";
import { bindPublicationOwner } from "./publication-owner-routing.server";
import { bindQaOperationalOwner } from "./qa-owner-operational-protocol";

const QA_PRIMARY_IDS = new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
  "3ffb3c0b-72b2-4a47-b63a-18aaf77762ea",
  "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3",
]);
// A mixed READ + typed-owner-command rehearsal may only use the two
// independently scoped publication QA primaries already recognized by the
// canonical publication command boundary. Never accept an arbitrary QA D1.
const QA_TYPED_OWNER_PRIMARY_IDS = new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
]);
// Dedicated BioSync QA is not a general-purpose backend data reader.
export const QA_OWNER_UNBOUND_READ_FLAG = "COVE_QA_OWNER_UNBOUND_READ_ENABLED";
type QaReadEnv = CoveEnv & {
  COVE_QA_OWNER_UNBOUND_READ_ENABLED?: string;
  COVE_QA_OPERATIONAL_OWNER_ENABLED?: string;
  COVE_RIGHTS_OWNER_ENABLED?: string;
  COVE_RIGHTS_OWNER_PRIMARY_ID?: string;
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT?: string;
  COVE_OWNER_EXCLUSIVE_WRITER_FENCE?: string;
  COVE_COMMERCE_OWNER_D1_FENCE?: string;
  COVE_PUBLICATION_COMMANDS_ENABLED?: string;
  COVE_LEGAL_WRITER_PRIMARY_ID?: string;
  COVE_PUBLICATION_COMMAND_TERRITORY?: string;
  COVE_PUBLICATION_COMMAND_CURRENCY?: string;
  FORE_DEFAULT_TERRITORY?: string;
};
export function scopeQaOwnerUnboundPrimaryRead<T extends QaReadEnv>(env: T): T {
  const flag = env.COVE_QA_OWNER_UNBOUND_READ_ENABLED;
  const operational = env.COVE_QA_OPERATIONAL_OWNER_ENABLED;
  if (![undefined, "0", "1"].includes(operational) || (operational === "1" && flag !== "1"))
    throw Error("qa_operational_caller_not_enrolled");
  if (flag === undefined || flag === "0") return env;
  // In the same DB-unbound backend, typed owner operations must traverse the
  // existing independently validated command gateway, never the SQL facade.
  // This enables only synthetic QA evidence, not a write delegation to D1.
  const commandFlag = env.COVE_PUBLICATION_COMMANDS_ENABLED;
  const typedCommands = commandFlag === "1";
  const qaPrimary = env.COVE_RIGHTS_OWNER_PRIMARY_ID || "";
  const now = Date.now();
  const expiry = Number(env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT);
  if (
    flag !== "1" ||
    env.FORE_ENVIRONMENT === "production" ||
    env.COVE_SSR_STAGING !== "1" ||
    env.COVE_RIGHTS_OWNER_ENABLED !== "1" ||
    !QA_PRIMARY_IDS.has(env.COVE_RIGHTS_OWNER_PRIMARY_ID || "") ||
    !Number.isSafeInteger(expiry) ||
    expiry <= now ||
    expiry > now + 15 * 60 * 1000 ||
    !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET || "") ||
    !env.LEGAL_AUTHORITY?.getByName ||
    // A caller retaining a D1 binding has not proved physical isolation.
    (env.DB !== undefined && env.DB !== null) ||
    // No unchecked mutation flag can turn the READ facade into a raw writer.
    ![undefined, "0", "1"].includes(commandFlag) ||
    (typedCommands &&
      (!QA_TYPED_OWNER_PRIMARY_IDS.has(qaPrimary) ||
        env.COVE_LEGAL_WRITER_PRIMARY_ID !== qaPrimary ||
        env.COVE_PUBLICATION_COMMAND_TERRITORY !== "US" ||
        env.COVE_PUBLICATION_COMMAND_CURRENCY !== "USD")) ||
    env.COVE_OWNER_EXCLUSIVE_WRITER_FENCE === "1" ||
    env.COVE_COMMERCE_OWNER_D1_FENCE === "1"
  )
    throw Error("qa_unbound_primary_read_not_certified");
  const owner = env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1");
  if (!owner || typeof owner.fetch !== "function")
    throw Error("qa_unbound_primary_read_not_certified");
  const db = bindPublicationOwner(createQaOwnerReadOnlyD1(owner, env.COVE_RIGHTS_OWNER_SECRET!), {
    owner,
    secret: env.COVE_RIGHTS_OWNER_SECRET!,
    territory: env.FORE_DEFAULT_TERRITORY || "US",
    currency: "USD",
  });
  if (operational === "1") bindQaOperationalOwner(db, owner, env);
  return { ...env, DB: db } as T;
}
