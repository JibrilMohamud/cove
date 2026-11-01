import { dispatchCanonicalOwnerCommand } from "./canonical-owner-command-gateway";

/** This enrollment is deliberately QA-only until a independently certified
 * production owner exists. Production remains on the old queue executor.
 * Once enabled, there is no caller-owned D1 fallback on provider failure. */
type OwnerPort = { fetch(request: Request): Promise<Response> };
export type AuthorSocialOwnerEnv = {
  DB: unknown;
  COVE_AUTHOR_SOCIAL_OWNER_QA?: string;
  COVE_LEGAL_CONSUMER_STAGE_ENABLED?: string;
  COVE_SSR_STAGING?: string;
  COVE_LEGAL_WRITER_PRIMARY_ID?: string;
  COVE_RIGHTS_OWNER_SECRET?: string;
  LEGAL_AUTHORITY?: { getByName(name: string): OwnerPort };
};
const QA_PRIMARY_IDS = new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
]);

export async function dispatchPrivateAuthorSocialFanout(
  env: AuthorSocialOwnerEnv,
  limit = 10,
  batchSize = 250,
) {
  if (
    env.COVE_AUTHOR_SOCIAL_OWNER_QA !== "1" ||
    env.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1" ||
    env.COVE_SSR_STAGING !== "1" ||
    !QA_PRIMARY_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID || "") ||
    !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET || "") ||
    !env.LEGAL_AUTHORITY?.getByName ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 10 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 250
  )
    throw Error("author_social_private_owner_not_enrolled");
  const operationId = "author-fanout:" + crypto.randomUUID();
  const port = env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1");
  // Only the owner sees primary D1. The caller cannot choose a cursor, SQL,
  // post, follower list, notification payload or positive customer grant.
  const receipt = await dispatchCanonicalOwnerCommand(
    port,
    env.COVE_RIGHTS_OWNER_SECRET!,
    "social.process-author-fanout",
    { operationId, limit, batchSize },
  );
  return {
    processed: receipt.processed as number,
    delivered: receipt.delivered as number,
    failed: receipt.failed as number,
  };
}
