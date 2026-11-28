import type { AuthoritySql } from "./legal-authority-core";
export type BaselineScope = {
  productId: string;
  territory: string;
  format: string;
  channel: string;
};
export type BaselineDecision = BaselineScope & {
  verdict: "allow" | "deny" | "quarantine";
  artifactSha256: string | null;
  policySha256: string | null;
  basisSha256: string | null;
  validUntilMs: number;
};
export type BaselineHeader = {
  schema: "cove.owner-current-baseline.v1";
  primaryId: string;
  generation: number;
  ownerEpoch: number;
  withdrawalSequence: number;
  inventorySha256: string;
  productCount: number;
  scopeCount: number;
  batchSha256: string[];
  observedAtMs: number;
  validUntilMs: number;
  defaultVerdict: "deny";
};
export type BaselineEnvelope = {
  header: BaselineHeader;
  publisherSignature: string;
  reviewerSignature: string;
};
export type BaselineSigner = { spkiBase64: string; spkiSha256: string };
export type BaselineTrust = {
  primaryId: string;
  publisher: BaselineSigner;
  reviewer: BaselineSigner;
  maxAgeMs: number;
};
export type BaselineInventory = {
  inventorySha256: string;
  productCount: number;
  ownerEpoch: number;
  withdrawalSequence: number;
};
const fail = (reason: string): never => {
  throw Error("current_legal_baseline_" + reason);
};
export const baselineInteger = (x: unknown): x is number =>
  Number.isSafeInteger(x) && Number(x) >= 0;
export const baselineDigest = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
export const baselineIdentity = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(x);
export const baselineExact = (x: unknown, keys: string) =>
  !!x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.keys(x).sort().join("|") === keys.split("|").sort().join("|");
const canonical = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.entries(x)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : x;
const encoded = (x: unknown) => new TextEncoder().encode(JSON.stringify(canonical(x)));
const hex = (x: ArrayBuffer) =>
  [...new Uint8Array(x)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const hashLegalBaseline = async (x: unknown) =>
  hex(await crypto.subtle.digest("SHA-256", encoded(x)));
function base64(s: string, url = false) {
  if (
    typeof s !== "string" ||
    s.length > 2048 ||
    !(url ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9+/]+={0,2}$/).test(s)
  )
    fail("encoding");
  return Uint8Array.from(atob(url ? s.replace(/-/g, "+").replace(/_/g, "/") : s), (c) =>
    c.charCodeAt(0),
  );
}
async function signer(input: BaselineSigner) {
  if (!input || !baselineDigest(input.spkiSha256)) fail("signer");
  const der = base64(input.spkiBase64);
  if (hex(await crypto.subtle.digest("SHA-256", der)) !== input.spkiSha256) fail("signer_pin");
  // Public keys are extractable solely to compare normalized EC points. The
  // same point in compressed/uncompressed SPKI is never independent review.
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  return { key, point: hex(await crypto.subtle.exportKey("raw", key)) };
}
async function validSignature(payload: unknown, signature: string, key: CryptoKey) {
  const bytes = base64(signature, true);
  if (
    bytes.length !== 64 ||
    btoa(String.fromCharCode(...bytes))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_") !== signature
  )
    return false;
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes, encoded(payload));
}
export function createCurrentLegalBaselineSchema(sql: AuthoritySql) {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_baseline_clock(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_epoch INTEGER NOT NULL,withdrawal_sequence INTEGER NOT NULL)",
  );
  sql.exec("INSERT OR IGNORE INTO cove_baseline_clock VALUES(1,0,0)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_baseline_invalidations(operation_id TEXT PRIMARY KEY,owner_epoch INTEGER NOT NULL,withdrawal_sequence INTEGER NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_baseline_generations(generation INTEGER PRIMARY KEY,owner_epoch INTEGER NOT NULL,withdrawal_sequence INTEGER NOT NULL,inventory_sha TEXT NOT NULL,product_count INTEGER NOT NULL,scope_count INTEGER NOT NULL,observed_ms INTEGER NOT NULL,valid_until_ms INTEGER NOT NULL,header_json TEXT NOT NULL,envelope_sha TEXT NOT NULL,envelope_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','sealed')))",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_baseline_batches(generation INTEGER NOT NULL,batch_index INTEGER NOT NULL,batch_sha TEXT NOT NULL,row_count INTEGER NOT NULL,PRIMARY KEY(generation,batch_index)) WITHOUT ROWID",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_baseline_decisions(generation INTEGER NOT NULL,product_id TEXT NOT NULL,territory TEXT NOT NULL,format TEXT NOT NULL,channel TEXT NOT NULL,verdict TEXT NOT NULL CHECK(verdict IN ('allow','deny','quarantine')),artifact_sha TEXT,policy_sha TEXT,basis_sha TEXT,valid_until_ms INTEGER NOT NULL,PRIMARY KEY(generation,product_id,territory,format,channel)) WITHOUT ROWID",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_baseline_head(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL)",
  );
}
export function baselineClock(sql: AuthoritySql) {
  const row = sql
    .exec<{ owner_epoch: number; withdrawal_sequence: number }>(
      "SELECT owner_epoch,withdrawal_sequence FROM cove_baseline_clock WHERE singleton=1",
    )
    .toArray()[0];
  if (!row) fail("clock_missing");
  const head = sql
    .exec<{ generation: number }>("SELECT generation FROM cove_baseline_head WHERE singleton=1")
    .toArray()[0];
  const high = sql
    .exec<{ n: number }>("SELECT COALESCE(MAX(generation),0) n FROM cove_baseline_generations")
    .toArray()[0].n;
  return {
    ownerEpoch: row.owner_epoch,
    withdrawalSequence: row.withdrawal_sequence,
    generation: head?.generation || 0,
    nextGeneration: high + 1,
  };
}
export function invalidateCurrentLegalBaseline(sql: AuthoritySql, operationId: string) {
  if (!baselineIdentity(operationId)) fail("invalidation_identity");
  const old = sql
    .exec<{ owner_epoch: number; withdrawal_sequence: number }>(
      "SELECT * FROM cove_baseline_invalidations WHERE operation_id=?",
      operationId,
    )
    .toArray()[0];
  if (old) return { ownerEpoch: old.owner_epoch, withdrawalSequence: old.withdrawal_sequence };
  sql.exec(
    "UPDATE cove_baseline_clock SET owner_epoch=owner_epoch+1,withdrawal_sequence=withdrawal_sequence+1 WHERE singleton=1",
  );
  const at = baselineClock(sql);
  sql.exec(
    "INSERT INTO cove_baseline_invalidations VALUES(?,?,?)",
    operationId,
    at.ownerEpoch,
    at.withdrawalSequence,
  );
  return at;
}
const live = (h: BaselineHeader, at: number) =>
  baselineInteger(at) &&
  baselineInteger(h.observedAtMs) &&
  baselineInteger(h.validUntilMs) &&
  h.observedAtMs <= at &&
  h.validUntilMs > at;
/** Async verification creates a synchronous transaction closure; commit repeats
 * all clock checks so withdrawal can interrupt any external crypto await. */
export async function beginCurrentLegalBaseline(
  sql: AuthoritySql,
  envelope: BaselineEnvelope,
  trust: BaselineTrust,
  inventory: BaselineInventory,
  nowMs: number,
) {
  if (!baselineExact(envelope, "header|publisherSignature|reviewerSignature")) fail("envelope");
  const h = envelope.header;
  if (
    !baselineExact(
      h,
      "schema|primaryId|generation|ownerEpoch|withdrawalSequence|inventorySha256|productCount|scopeCount|batchSha256|observedAtMs|validUntilMs|defaultVerdict",
    ) ||
    h.schema !== "cove.owner-current-baseline.v1" ||
    h.defaultVerdict !== "deny" ||
    h.primaryId !== trust.primaryId ||
    !baselineIdentity(h.primaryId) ||
    !baselineInteger(h.generation) ||
    h.generation < 1 ||
    !baselineInteger(h.ownerEpoch) ||
    !baselineInteger(h.withdrawalSequence) ||
    h.inventorySha256 !== inventory.inventorySha256 ||
    !baselineDigest(h.inventorySha256) ||
    h.productCount !== inventory.productCount ||
    !baselineInteger(h.productCount) ||
    h.productCount < 1 ||
    h.productCount > 1000000 ||
    h.ownerEpoch !== inventory.ownerEpoch ||
    h.withdrawalSequence !== inventory.withdrawalSequence ||
    !baselineInteger(h.scopeCount) ||
    h.scopeCount > 1000000 ||
    !Array.isArray(h.batchSha256) ||
    h.batchSha256.length > 4096 ||
    h.batchSha256.some((x) => !baselineDigest(x)) ||
    h.scopeCount > h.batchSha256.length * 256 ||
    !live(h, nowMs) ||
    !baselineInteger(trust.maxAgeMs) ||
    trust.maxAgeMs < 1 ||
    trust.maxAgeMs > 900000 ||
    h.validUntilMs - h.observedAtMs > trust.maxAgeMs
  )
    fail("header_binding");
  const [publisher, reviewer] = await Promise.all([
    signer(trust.publisher),
    signer(trust.reviewer),
  ]);
  if (
    publisher.point === reviewer.point ||
    !(await validSignature(h, envelope.publisherSignature, publisher.key)) ||
    !(await validSignature(h, envelope.reviewerSignature, reviewer.key))
  )
    fail("independent_signatures");
  const envelopeSha = await hashLegalBaseline(envelope);
  return () => {
    const at = baselineClock(sql);
    if (at.ownerEpoch !== h.ownerEpoch || at.withdrawalSequence !== h.withdrawalSequence)
      fail("owner_clock_conflict");
    const old = sql
      .exec<{ envelope_sha: string }>(
        "SELECT envelope_sha FROM cove_baseline_generations WHERE generation=?",
        h.generation,
      )
      .toArray()[0];
    if (old) {
      if (old.envelope_sha !== envelopeSha) fail("generation_collision");
      return { generation: h.generation, replayed: true };
    }
    if (h.generation !== at.nextGeneration) fail("generation_highwater");
    sql.exec(
      "INSERT INTO cove_baseline_generations VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending')",
      h.generation,
      h.ownerEpoch,
      h.withdrawalSequence,
      h.inventorySha256,
      h.productCount,
      h.scopeCount,
      h.observedAtMs,
      h.validUntilMs,
      JSON.stringify(h),
      envelopeSha,
      JSON.stringify(envelope),
    );
    return { generation: h.generation, replayed: false };
  };
}
export async function appendCurrentLegalBaselineBatch(
  sql: AuthoritySql,
  generation: number,
  index: number,
  rows: BaselineDecision[],
  nowMs: number,
) {
  if (
    !baselineInteger(generation) ||
    !baselineInteger(index) ||
    !Array.isArray(rows) ||
    rows.length < 1 ||
    rows.length > 256
  )
    fail("batch_shape");
  const record = sql
    .exec<{ header_json: string; state: string }>(
      "SELECT header_json,state FROM cove_baseline_generations WHERE generation=?",
      generation,
    )
    .toArray()[0];
  if (!record) fail("generation_missing");
  const h: BaselineHeader = JSON.parse(record.header_json);
  if (!live(h, nowMs) || index >= h.batchSha256.length) fail("batch_clock");
  for (const r of rows)
    if (
      !baselineExact(
        r,
        "productId|territory|format|channel|verdict|artifactSha256|policySha256|basisSha256|validUntilMs",
      ) ||
      !baselineIdentity(r.productId) ||
      !/^[A-Z]{2}$/.test(r.territory) ||
      !["ebook", "audiobook"].includes(r.format) ||
      !["retail", "subscription", "library"].includes(r.channel) ||
      !["allow", "deny", "quarantine"].includes(r.verdict) ||
      !baselineInteger(r.validUntilMs) ||
      [r.artifactSha256, r.policySha256, r.basisSha256].some(
        (x) => x !== null && !baselineDigest(x),
      ) ||
      (r.verdict === "allow"
        ? !baselineDigest(r.artifactSha256) ||
          !baselineDigest(r.policySha256) ||
          !baselineDigest(r.basisSha256) ||
          r.validUntilMs <= nowMs ||
          r.validUntilMs > h.validUntilMs
        : r.validUntilMs !== 0)
    )
      fail("decision_shape");
  const batchSha = await hashLegalBaseline(rows);
  if (batchSha !== h.batchSha256[index]) fail("batch_digest");
  return () => {
    const at = baselineClock(sql);
    if (at.ownerEpoch !== h.ownerEpoch || at.withdrawalSequence !== h.withdrawalSequence)
      fail("owner_clock_conflict");
    const old = sql
      .exec<{ batch_sha: string }>(
        "SELECT batch_sha FROM cove_baseline_batches WHERE generation=? AND batch_index=?",
        generation,
        index,
      )
      .toArray()[0];
    if (old) {
      if (old.batch_sha !== batchSha) fail("batch_collision");
      return { saved: rows.length, replayed: true };
    }
    if (
      record.state !== "pending" ||
      sql
        .exec<{ state: string }>(
          "SELECT state FROM cove_baseline_generations WHERE generation=?",
          generation,
        )
        .toArray()[0].state !== "pending"
    )
      fail("generation_not_pending");
    for (const r of rows)
      sql.exec(
        "INSERT INTO cove_baseline_decisions VALUES(?,?,?,?,?,?,?,?,?,?)",
        generation,
        r.productId,
        r.territory,
        r.format,
        r.channel,
        r.verdict,
        r.artifactSha256,
        r.policySha256,
        r.basisSha256,
        r.validUntilMs,
      );
    sql.exec(
      "INSERT INTO cove_baseline_batches VALUES(?,?,?,?)",
      generation,
      index,
      batchSha,
      rows.length,
    );
    return { saved: rows.length, replayed: false };
  };
}
export function sealCurrentLegalBaseline(sql: AuthoritySql, generation: number, nowMs: number) {
  if (!baselineInteger(generation)) fail("generation");
  const r = sql
    .exec<{ header_json: string; state: string }>(
      "SELECT header_json,state FROM cove_baseline_generations WHERE generation=?",
      generation,
    )
    .toArray()[0];
  if (!r) fail("generation_missing");
  const h: BaselineHeader = JSON.parse(r.header_json),
    at = baselineClock(sql);
  if (
    !live(h, nowMs) ||
    at.ownerEpoch !== h.ownerEpoch ||
    at.withdrawalSequence !== h.withdrawalSequence
  )
    fail("seal_clock");
  const receipt = { generation, classifiedScopes: h.scopeCount, defaultVerdict: "deny" as const };
  if (r.state === "sealed") {
    if (at.generation !== generation) fail("seal_superseded");
    return receipt;
  }
  if (generation <= at.generation) fail("seal_generation");
  const batches = sql
    .exec<{ batch_index: number; batch_sha: string; row_count: number }>(
      "SELECT * FROM cove_baseline_batches WHERE generation=? ORDER BY batch_index",
      generation,
    )
    .toArray();
  const count = sql
    .exec<{ n: number }>(
      "SELECT COUNT(*) n FROM cove_baseline_decisions WHERE generation=?",
      generation,
    )
    .toArray()[0].n;
  if (
    batches.length !== h.batchSha256.length ||
    batches.some((r, i) => r.batch_index !== i || r.batch_sha !== h.batchSha256[i]) ||
    batches.reduce((n, r) => n + r.row_count, 0) !== h.scopeCount ||
    count !== h.scopeCount
  )
    fail("incomplete_partition");
  sql.exec("UPDATE cove_baseline_generations SET state='sealed' WHERE generation=?", generation);
  sql.exec(
    "INSERT INTO cove_baseline_head VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation",
    generation,
  );
  return receipt;
}
export function currentLegalBaselineReady(sql: AuthoritySql, nowMs = Date.now()) {
  if (!baselineInteger(nowMs)) return null;
  return (
    sql
      .exec<{ generation: number; ownerEpoch: number; withdrawalSequence: number }>(
        "SELECT g.generation,g.owner_epoch ownerEpoch,g.withdrawal_sequence withdrawalSequence FROM cove_baseline_head h JOIN cove_baseline_generations g ON g.generation=h.generation JOIN cove_baseline_clock c ON c.singleton=1 AND c.owner_epoch=g.owner_epoch AND c.withdrawal_sequence=g.withdrawal_sequence WHERE h.singleton=1 AND g.state='sealed' AND g.observed_ms<=? AND g.valid_until_ms>?",
        nowMs,
        nowMs,
      )
      .toArray()[0] || null
  );
}
export function readCurrentLegalBaseline(
  sql: AuthoritySql,
  scope: BaselineScope,
  current: {
    artifactSha256: string | null;
    policySha256: string | null;
    canonicalAllowed: boolean;
    outstandingHold: boolean;
  },
  nowMs = Date.now(),
) {
  if (
    !current ||
    current.canonicalAllowed !== true ||
    current.outstandingHold !== false ||
    !baselineDigest(current.artifactSha256) ||
    !baselineDigest(current.policySha256) ||
    !baselineIdentity(scope.productId) ||
    !/^[A-Z]{2}$/.test(scope.territory) ||
    !["ebook", "audiobook"].includes(scope.format) ||
    !["retail", "subscription", "library"].includes(scope.channel)
  )
    return false;
  const head = currentLegalBaselineReady(sql, nowMs);
  if (!head) return false;
  return (
    sql
      .exec(
        "SELECT 1 allowed FROM cove_baseline_decisions WHERE generation=? AND product_id=? AND territory=? AND format=? AND channel=? AND verdict='allow' AND artifact_sha=? AND policy_sha=? AND valid_until_ms>?",
        head.generation,
        scope.productId,
        scope.territory,
        scope.format,
        scope.channel,
        current.artifactSha256,
        current.policySha256,
        nowMs,
      )
      .toArray().length > 0
  );
}
/** Denial survives evidence expiry or withdrawal. It can never serve content;
 * a newer head containing any allowance immediately disables this mode. */
export function currentLegalBaselineQuarantineReady(sql: AuthoritySql) {
  const row = sql
    .exec<{
      generation: number;
      header_json: string;
      scope_count: number;
      product_count: number;
      allows: number;
    }>(
      "SELECT g.generation,g.header_json,g.scope_count,g.product_count,(SELECT COUNT(*) FROM cove_baseline_decisions d WHERE d.generation=g.generation AND d.verdict='allow') allows FROM cove_baseline_head h JOIN cove_baseline_generations g ON g.generation=h.generation WHERE h.singleton=1 AND g.state='sealed'",
    )
    .toArray()[0];
  if (!row || row.allows !== 0 || row.product_count < 1) return null;
  try {
    const header: BaselineHeader = JSON.parse(row.header_json);
    if (
      header.defaultVerdict !== "deny" ||
      header.generation !== row.generation ||
      !baselineDigest(header.inventorySha256)
    )
      return null;
    return {
      generation: row.generation,
      inventorySha256: header.inventorySha256,
      productCount: row.product_count,
      scopeCount: row.scope_count,
      defaultVerdict: "deny" as const,
    };
  } catch {
    return null;
  }
}
