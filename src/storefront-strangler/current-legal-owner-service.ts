import type { CatalogDB } from "../features/fore/catalog-model.server";
import { currentCanonicalLegalFacts } from "./current-legal-owner-inventory";
import {
  createCurrentLegalCaptureSchema,
  startCurrentLegalCapture,
  advanceCurrentLegalCapture,
  readCurrentLegalCapture,
  readCurrentLegalCapturePage,
  type BaselineStorage,
} from "./current-legal-owner-capture";
import {
  createCurrentLegalBaselineSchema,
  baselineClock,
  beginCurrentLegalBaseline,
  appendCurrentLegalBaselineBatch,
  sealCurrentLegalBaseline,
  readCurrentLegalBaseline,
  currentLegalBaselineReady,
  hashLegalBaseline,
  baselineExact,
  baselineDigest,
  type BaselineEnvelope,
  type BaselineTrust,
  type BaselineDecision,
  type BaselineScope,
} from "./current-legal-owner-baseline";
export const CURRENT_LEGAL_BASELINE_PREFIX = "/legal-baseline/";
export function createCurrentLegalOwnerServiceSchema(storage: BaselineStorage) {
  createCurrentLegalBaselineSchema(storage.sql);
  createCurrentLegalCaptureSchema(storage.sql);
}
export async function handleCurrentLegalOwnerService({
  route,
  raw,
  db,
  storage,
  primaryId,
  trustJson,
  nowMs = Date.now(),
}: {
  route: string;
  raw: unknown;
  db: CatalogDB;
  storage: BaselineStorage;
  primaryId: string;
  trustJson?: string;
  nowMs?: number;
}) {
  createCurrentLegalOwnerServiceSchema(storage);
  const sql = storage.sql;
  if (route === CURRENT_LEGAL_BASELINE_PREFIX + "capture") {
    if (!baselineExact(raw, "challenge")) throw Error("baseline_capture_input");
    return {
      ...(await startCurrentLegalCapture(storage, (raw as { challenge: string }).challenge, nowMs)),
      primaryId,
    };
  }
  if (route === CURRENT_LEGAL_BASELINE_PREFIX + "capture-next") {
    if (!baselineExact(raw, "captureId|index")) throw Error("baseline_capture_input");
    const x = raw as { captureId: string; index: number };
    return {
      ...(await advanceCurrentLegalCapture(storage, db, x.captureId, x.index, nowMs)),
      primaryId,
    };
  }
  if (route === CURRENT_LEGAL_BASELINE_PREFIX + "capture-status") {
    if (!baselineExact(raw, "captureId")) throw Error("baseline_capture_input");
    return { ...readCurrentLegalCapture(sql, (raw as { captureId: string }).captureId), primaryId };
  }
  if (route === CURRENT_LEGAL_BASELINE_PREFIX + "capture-page") {
    if (!baselineExact(raw, "captureId|index")) throw Error("baseline_capture_input");
    const x = raw as { captureId: string; index: number };
    return readCurrentLegalCapturePage(sql, x.captureId, x.index);
  }
  if (route === CURRENT_LEGAL_BASELINE_PREFIX + "quarantine-all") {
    if (!baselineExact(raw, "captureId")) throw Error("baseline_quarantine_input");
    const id = (raw as { captureId: string }).captureId;
    if (!baselineDigest(id)) throw Error("baseline_capture_identity");
    const capture = readCurrentLegalCapture(sql, id),
      at = baselineClock(sql);
    if (
      !capture.complete ||
      capture.ownerEpoch !== at.ownerEpoch ||
      capture.withdrawalSequence !== at.withdrawalSequence
    )
      throw Error("baseline_capture_required");
    const generation = at.nextGeneration;
    const header = {
      schema: "cove.owner-current-baseline.v1",
      primaryId,
      generation,
      ownerEpoch: at.ownerEpoch,
      withdrawalSequence: at.withdrawalSequence,
      inventorySha256: capture.inventorySha256,
      productCount: capture.productCount,
      scopeCount: 0,
      batchSha256: [],
      observedAtMs: nowMs,
      validUntilMs: nowMs + 900000,
      defaultVerdict: "deny",
    };
    const envelope = { kind: "owner-denial-only", header },
      digest = await hashLegalBaseline(envelope);
    return storage.transactionSync(() => {
      const current = baselineClock(sql);
      if (
        current.ownerEpoch !== at.ownerEpoch ||
        current.withdrawalSequence !== at.withdrawalSequence ||
        current.nextGeneration !== generation
      )
        throw Error("baseline_quarantine_clock");
      sql.exec(
        "INSERT INTO cove_baseline_generations VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending')",
        generation,
        at.ownerEpoch,
        at.withdrawalSequence,
        capture.inventorySha256,
        capture.productCount,
        0,
        nowMs,
        nowMs + 900000,
        JSON.stringify(header),
        digest,
        JSON.stringify(envelope),
      );
      return {
        ...sealCurrentLegalBaseline(sql, generation, nowMs),
        inventorySha256: capture.inventorySha256,
        productCount: capture.productCount,
        recordedScopes: capture.scopeCount,
        independentlyAuthorized: 0,
        quarantinedProducts: capture.productCount,
        authorizing: false,
      };
    });
  }
  if (route === CURRENT_LEGAL_BASELINE_PREFIX + "begin") {
    if (!baselineExact(raw, "envelope") || !trustJson || trustJson.length > 8192)
      throw Error("baseline_trust_unconfigured");
    const trust = JSON.parse(trustJson) as BaselineTrust;
    if (trust.primaryId !== primaryId) throw Error("baseline_primary_mismatch");
    const capture = sql
      .exec<{
        inventory_sha: string;
        product_count: number;
        owner_epoch: number;
        withdrawal_sequence: number;
        observed_ms: number;
      }>("SELECT * FROM cove_baseline_inventory WHERE singleton=1")
      .toArray()[0];
    if (!capture || capture.observed_ms > nowMs || nowMs - capture.observed_ms > 900000)
      throw Error("baseline_capture_required");
    const commit = await beginCurrentLegalBaseline(
      sql,
      (raw as { envelope: BaselineEnvelope }).envelope,
      trust,
      {
        inventorySha256: capture.inventory_sha,
        productCount: capture.product_count,
        ownerEpoch: capture.owner_epoch,
        withdrawalSequence: capture.withdrawal_sequence,
      },
      nowMs,
    );
    return { ...storage.transactionSync(commit), authorizing: false };
  }
  if (route === CURRENT_LEGAL_BASELINE_PREFIX + "append") {
    if (!baselineExact(raw, "generation|index|rows")) throw Error("baseline_append_input");
    const x = raw as { generation: number; index: number; rows: BaselineDecision[] };
    const generation = sql
      .exec<{ inventory_sha: string }>(
        "SELECT inventory_sha FROM cove_baseline_generations WHERE generation=?",
        x.generation,
      )
      .toArray()[0];
    const capture =
      generation &&
      sql
        .exec<{ capture_id: string }>(
          "SELECT capture_id FROM cove_baseline_captures WHERE inventory_sha=? AND phase='sealed' ORDER BY started_ms DESC LIMIT 1",
          generation.inventory_sha,
        )
        .toArray()[0];
    if (!capture || !Array.isArray(x.rows) || x.rows.length > 256)
      throw Error("baseline_append_capture");
    for (const r of x.rows) {
      const current = sql
        .exec<{
          artifact_sha: string | null;
          policy_sha: string | null;
          canonical_allowed: number;
          outstanding_hold: number;
        }>(
          "SELECT * FROM cove_baseline_capture_scopes WHERE capture_id=? AND product_id=? AND territory=? AND format=? AND channel=?",
          capture.capture_id,
          r.productId,
          r.territory,
          r.format,
          r.channel,
        )
        .toArray()[0];
      if (
        !current ||
        r.artifactSha256 !== current.artifact_sha ||
        r.policySha256 !== current.policy_sha ||
        (r.verdict === "allow" &&
          (current.canonical_allowed !== 1 || current.outstanding_hold !== 0))
      )
        throw Error("baseline_append_scope_binding");
    }
    const commit = await appendCurrentLegalBaselineBatch(sql, x.generation, x.index, x.rows, nowMs);
    return { ...storage.transactionSync(commit), authorizing: false };
  }
  if (route === CURRENT_LEGAL_BASELINE_PREFIX + "seal") {
    if (!baselineExact(raw, "generation")) throw Error("baseline_seal_input");
    return {
      ...storage.transactionSync(() =>
        sealCurrentLegalBaseline(sql, (raw as { generation: number }).generation, nowMs),
      ),
      authorizing: false,
    };
  }
  if (route === CURRENT_LEGAL_BASELINE_PREFIX + "inspect") {
    if (!baselineExact(raw, "productId|territory|format|channel"))
      throw Error("baseline_scope_input");
    const scope = raw as BaselineScope;
    const current = await currentCanonicalLegalFacts(db, sql, scope, nowMs);
    return {
      schema: "cove.current-baseline-consumer.v1",
      baselineAllowed: readCurrentLegalBaseline(sql, scope, current, nowMs),
      allowed: false,
      authorizing: false,
      head: currentLegalBaselineReady(sql, nowMs),
    };
  }
  throw Error("baseline_unknown_route");
}
