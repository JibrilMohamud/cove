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

const QA_PRIMARY_IDS = new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
  "3ffb3c0b-72b2-4a47-b63a-18aaf77762ea",
  "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3",
]);
// Dedicated BioSync QA is not a general-purpose backend data reader.
export const QA_OWNER_UNBOUND_READ_FLAG = "COVE_QA_OWNER_UNBOUND_READ_ENABLED";
type QaReadEnv = CoveEnv & {
  COVE_QA_OWNER_UNBOUND_READ_ENABLED?: string;
  COVE_RIGHTS_OWNER_ENABLED?: string;
  COVE_RIGHTS_OWNER_PRIMARY_ID?: string;
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT?: string;
  COVE_OWNER_EXCLUSIVE_WRITER_FENCE?: string;
  COVE_COMMERCE_OWNER_D1_FENCE?: string;
};
export function scopeQaOwnerUnboundPrimaryRead<T extends QaReadEnv>(env: T): T {
  const flag = env.COVE_QA_OWNER_UNBOUND_READ_ENABLED;
  if (flag === undefined || flag === "0") return env;
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
    // This phase proves read continuity only. Don't imply that legitimate
    // business writes or mixed owner command paths have been migrated.
    env.COVE_PUBLICATION_COMMANDS_ENABLED === "1" ||
    env.COVE_OWNER_EXCLUSIVE_WRITER_FENCE === "1" ||
    env.COVE_COMMERCE_OWNER_D1_FENCE === "1"
  )
    throw Error("qa_unbound_primary_read_not_certified");
  const owner = env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1");
  if (!owner || typeof owner.fetch !== "function")
    throw Error("qa_unbound_primary_read_not_certified");
  return { ...env, DB: createQaOwnerReadOnlyD1(owner, env.COVE_RIGHTS_OWNER_SECRET!) } as T;
}
