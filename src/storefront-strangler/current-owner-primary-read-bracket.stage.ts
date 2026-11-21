/**
 * Isolated QA-only owner/primary read bracket. This is not an authorization
 * proof, does not accept production D1, and is not imported by a serving route.
 *
 * The independently owned Durable Object can acknowledge a denial BEFORE
 * the matching primary D1 transaction commits. A primary read alone can
 * therefore expose a legally stale grant. Fail closed unless the fresh owner
 * mutation epoch matches a separately published, clean primary generation
 * BOTH before and after the caller's already-authorized read.
 *
 * The primary-fence table is a proposed QA publication interface, NOT an
 * existing production schema. The sole valid publisher would be the legally
 * approved owner using a same-statement generation CAS. Never fabricate or
 * initialize a primary epoch from a reader. No flag, cache or client header
 * may turn this into an authorizing production endpoint.
 */
export const QA_OWNER_PRIMARY_FENCE_SCHEMA = "cove.qa.owner-primary-read-bracket.v1";
export const QA_OWNER_PRIMARY_FENCE_SQL =
  "SELECT publication_schema,primary_id,owner_journal_version,owner_mutation_epoch," +
  "owner_rehearsal_revision,dirty,pending_withdrawals,pending_writes," +
  "eligibility_valid_until_ms FROM cove_qa_owner_primary_publication_fence WHERE slot=1";

const QA_IDS = new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
]);
const OWNER_RECEIPT_SCHEMA = "cove.qa.current-owner-sql-journal.v1";
const OWNER_URL = "https://legal-authority.internal/qa/current-mutation-fence";

type OwnerPort = { fetch(request: Request): Promise<Response> };
export type PrimaryFenceStatement = { first<T = unknown>(): Promise<T | null> };
export type PrimaryFenceSession = { prepare(sql: string): PrimaryFenceStatement };
export type PrimaryFenceDB = {
  withSession(mode: "first-primary"): PrimaryFenceSession;
};
export type QaOwnerReadBracket = {
  owner: OwnerPort;
  secret: string;
  primary: PrimaryFenceDB;
  primaryId: string;
  journalVersion: string;
  nowMs?: () => number;
};

type OwnerEpoch = {
  epoch: number;
  version: string;
  primaryId: string;
  rehearsal: "A" | "B";
};
type PrimaryRow = Record<string, unknown>;

function fail(): never {
  throw Error("qa_owner_primary_read_not_current");
}
function strictEpoch(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    return fail();
  return Number(value);
}
function validSetup(x: QaOwnerReadBracket) {
  if (
    !x ||
    !QA_IDS.has(x.primaryId) ||
    !/^[a-f0-9]{64}$/.test(x.secret || "") ||
    !/^[a-f0-9]{64}$/.test(x.journalVersion || "") ||
    typeof x.owner?.fetch !== "function" ||
    typeof x.primary?.withSession !== "function"
  )
    fail();
}
function challengeHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
}
/** Bound actual body consumption, not just Content-Length or a post-hoc
 * response.text() check. A compromised private service cannot force an
 * unbounded allocation while returning an invalid authority receipt. */
async function boundedOwnerReceipt(response: Response): Promise<string> {
  if (!response.body) fail();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let receivedBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      receivedBytes += next.value.byteLength;
      // Count actual UTF-8 bytes, including multi-byte text. The error
      // response cannot force unbounded decoding or string allocations.
      if (receivedBytes > 2048) {
        await reader.cancel().catch(() => undefined);
        fail();
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    fail();
  } finally {
    reader.releaseLock();
  }
  if (text.length > 2048) fail();
  return text;
}
async function ownerEpoch(x: QaOwnerReadBracket): Promise<OwnerEpoch> {
  const challenge = challengeHex();
  const response = await x.owner.fetch(
    new Request(OWNER_URL, {
      method: "POST",
      headers: {
        authorization: "Bearer " + x.secret,
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ challenge }),
    }),
  );
  if (
    response.status !== 200 ||
    !/\bno-store\b/i.test(response.headers.get("cache-control") || "") ||
    !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") || "")
  )
    fail();
  const sizeHeader = response.headers.get("content-length");
  if (sizeHeader && (!/^\d+$/.test(sizeHeader) || Number(sizeHeader) > 2048)) fail();
  const raw = await boundedOwnerReceipt(response);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail();
  const receipt = data as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join(",") !==
      "authorizing,challenge,journalVersion,mutationEpoch,primaryId,rehearsalRevision,schema,tables,triggers" ||
    receipt.schema !== OWNER_RECEIPT_SCHEMA ||
    receipt.challenge !== challenge ||
    receipt.primaryId !== x.primaryId ||
    receipt.journalVersion !== x.journalVersion ||
    receipt.authorizing !== false ||
    receipt.tables !== 24 ||
    receipt.triggers !== 78 ||
    (receipt.rehearsalRevision !== "A" && receipt.rehearsalRevision !== "B")
  )
    fail();
  const epoch = strictEpoch(receipt.mutationEpoch);
  // A virgin, uninitialized QA owner cannot authorize a published catalog.
  if (epoch < 1) fail();
  return {
    epoch,
    version: x.journalVersion,
    primaryId: x.primaryId,
    rehearsal: receipt.rehearsalRevision,
  };
}
function openPrimary(x: QaOwnerReadBracket): PrimaryFenceSession {
  const db = x.primary.withSession("first-primary");
  if (typeof db?.prepare !== "function") fail();
  return db;
}
async function checkedPrimary(
  x: QaOwnerReadBracket,
  owner: OwnerEpoch,
  timeMs: number,
): Promise<PrimaryFenceSession> {
  const db = openPrimary(x);
  const row = await db.prepare(QA_OWNER_PRIMARY_FENCE_SQL).first<PrimaryRow>();
  if (
    !row ||
    row.publication_schema !== QA_OWNER_PRIMARY_FENCE_SCHEMA ||
    row.primary_id !== owner.primaryId ||
    row.owner_journal_version !== owner.version ||
    row.owner_mutation_epoch !== owner.epoch ||
    row.owner_rehearsal_revision !== owner.rehearsal ||
    row.dirty !== 0 ||
    row.pending_withdrawals !== 0 ||
    row.pending_writes !== 0 ||
    !Number.isSafeInteger(row.eligibility_valid_until_ms) ||
    Number(row.eligibility_valid_until_ms) <= timeMs ||
    // Do not accept an unbounded static "forever" horizon.
    Number(row.eligibility_valid_until_ms) > timeMs + 5 * 60_000
  )
    fail();
  return db;
}

/**
 * Extra QA denial fence around an independently rights-authorized read. The
 * callback MUST run the full current deny-first legal/offer checks itself:
 * an owner epoch is an invalidation witness, not a grant to sell or deliver.
 *
 * No result escapes until two fresh owner challenges and two independently
 * first-primary D1 sessions agree on epoch, version, rehearsal and expiry.
 * A missing owner/primary, pending reconciliation, schema anomaly or racing
 * owner withdrawal fails closed, even if the catalog callback succeeded.
 */
export async function withCurrentQaOwnerPrimaryRead<T>(
  x: QaOwnerReadBracket,
  alreadyRightsAuthorizedRead: () => Promise<T>,
): Promise<T> {
  validSetup(x);
  if (typeof alreadyRightsAuthorizedRead !== "function") fail();
  const now = x.nowMs || Date.now;
  let previousTime = 0;
  const currentTime = () => {
    const value = now();
    // A missing, invalid or rewinding clock cannot extend eligibility.
    if (!Number.isSafeInteger(value) || value < 1 || value < previousTime) fail();
    previousTime = value;
    return value;
  };
  const firstOwner = await ownerEpoch(x);
  await checkedPrimary(x, firstOwner, currentTime());
  // Never hand the fenced D1 adapter to the callback: the primary reader
  // cannot become an unreviewed SQL mutation executor by accident.
  const result = await alreadyRightsAuthorizedRead();
  // Fresh primary session, not a possibly stale bookmark from the catalog
  // session. An accepted D1 snapshot does not substitute for the owner check.
  await checkedPrimary(x, firstOwner, currentTime());
  const latestOwner = await ownerEpoch(x);
  if (
    latestOwner.epoch !== firstOwner.epoch ||
    latestOwner.version !== firstOwner.version ||
    latestOwner.primaryId !== firstOwner.primaryId ||
    latestOwner.rehearsal !== firstOwner.rehearsal
  )
    fail();
  // A horizon can expire while the last owner RPC is in flight.
  await checkedPrimary(x, latestOwner, currentTime());
  return result;
}
