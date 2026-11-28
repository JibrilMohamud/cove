import type { AuthoritySql } from "./legal-authority-core";
import type { CatalogDB } from "../features/fore/catalog-model.server";
import { captureCanonicalLegalInventoryPage } from "./current-legal-owner-inventory";
import {
  baselineClock,
  baselineDigest,
  baselineInteger,
  hashLegalBaseline,
} from "./current-legal-owner-baseline";
export type BaselineStorage = { sql: AuthoritySql; transactionSync<T>(fn: () => T): T };
type Capture = {
  capture_id: string;
  owner_epoch: number;
  withdrawal_sequence: number;
  phase: "products" | "scopes" | "sealed";
  cursor: string;
  page_index: number;
  product_count: number;
  scope_count: number;
  started_ms: number;
  rolling_sha: string;
  inventory_sha: string | null;
};
export function createCurrentLegalCaptureSchema(sql: AuthoritySql) {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_baseline_captures(capture_id TEXT PRIMARY KEY,owner_epoch INTEGER NOT NULL,withdrawal_sequence INTEGER NOT NULL,phase TEXT NOT NULL,cursor TEXT NOT NULL,page_index INTEGER NOT NULL,product_count INTEGER NOT NULL,scope_count INTEGER NOT NULL,started_ms INTEGER NOT NULL,rolling_sha TEXT NOT NULL,inventory_sha TEXT)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_baseline_capture_pages(capture_id TEXT NOT NULL,page_index INTEGER NOT NULL,kind TEXT NOT NULL,page_sha TEXT NOT NULL,rows_json TEXT NOT NULL,PRIMARY KEY(capture_id,page_index)) WITHOUT ROWID",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_baseline_capture_scopes(capture_id TEXT NOT NULL,product_id TEXT NOT NULL,territory TEXT NOT NULL,format TEXT NOT NULL,channel TEXT NOT NULL,artifact_sha TEXT,policy_sha TEXT,canonical_allowed INTEGER NOT NULL,outstanding_hold INTEGER NOT NULL,PRIMARY KEY(capture_id,product_id,territory,format,channel)) WITHOUT ROWID",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cove_baseline_inventory(singleton INTEGER PRIMARY KEY CHECK(singleton=1),capture_id TEXT NOT NULL,inventory_sha TEXT NOT NULL,product_count INTEGER NOT NULL,owner_epoch INTEGER NOT NULL,withdrawal_sequence INTEGER NOT NULL,observed_ms INTEGER NOT NULL)",
  );
}
function descriptor(x: Capture) {
  return {
    schema: "cove.canonical-owner-paged-inventory.v1",
    ownerEpoch: x.owner_epoch,
    withdrawalSequence: x.withdrawal_sequence,
    productCount: x.product_count,
    scopeCount: x.scope_count,
    pageCount: x.page_index,
    rootSha256: x.rolling_sha,
    defaultVerdict: "deny",
  };
}
function receipt(x: Capture) {
  return {
    captureId: x.capture_id,
    ownerEpoch: x.owner_epoch,
    withdrawalSequence: x.withdrawal_sequence,
    complete: x.phase === "sealed",
    phase: x.phase,
    nextIndex: x.page_index,
    productCount: x.product_count,
    scopeCount: x.scope_count,
    inventorySha256: x.inventory_sha,
    ...(x.phase === "sealed" ? { descriptor: descriptor(x) } : {}),
    authorizing: false,
  };
}
function sameClock(sql: AuthoritySql, x: Capture) {
  const c = baselineClock(sql);
  return c.ownerEpoch === x.owner_epoch && c.withdrawalSequence === x.withdrawal_sequence;
}
function get(sql: AuthoritySql, id: string) {
  if (!baselineDigest(id)) throw Error("baseline_capture_id");
  const x = sql
    .exec<Capture>("SELECT * FROM cove_baseline_captures WHERE capture_id=?", id)
    .toArray()[0];
  if (!x) throw Error("baseline_capture_missing");
  return x;
}
export function readCurrentLegalCapture(sql: AuthoritySql, id: string) {
  return receipt(get(sql, id));
}
export function readCurrentLegalCapturePage(sql: AuthoritySql, id: string, index: number) {
  get(sql, id);
  if (!baselineInteger(index)) throw Error("baseline_capture_page_index");
  const p = sql
    .exec<{ page_index: number; kind: string; page_sha: string; rows_json: string }>(
      "SELECT * FROM cove_baseline_capture_pages WHERE capture_id=? AND page_index=?",
      id,
      index,
    )
    .toArray()[0];
  if (!p) throw Error("baseline_capture_page_missing");
  return { index: p.page_index, kind: p.kind, sha256: p.page_sha, rows: JSON.parse(p.rows_json) };
}
export async function startCurrentLegalCapture(
  storage: BaselineStorage,
  challenge: string,
  nowMs: number,
) {
  if (
    typeof challenge !== "string" ||
    !/^[a-f0-9]{32,64}$/.test(challenge) ||
    !baselineInteger(nowMs)
  )
    throw Error("baseline_capture_challenge");
  const c = baselineClock(storage.sql),
    id = await hashLegalBaseline({
      challenge,
      ownerEpoch: c.ownerEpoch,
      withdrawalSequence: c.withdrawalSequence,
    });
  const seed = await hashLegalBaseline({
    schema: "cove.canonical-owner-capture-seed.v1",
    ownerEpoch: c.ownerEpoch,
    withdrawalSequence: c.withdrawalSequence,
  });
  return storage.transactionSync(() => {
    const current = baselineClock(storage.sql);
    if (current.ownerEpoch !== c.ownerEpoch || current.withdrawalSequence !== c.withdrawalSequence)
      throw Error("baseline_capture_clock");
    storage.sql.exec(
      "INSERT OR IGNORE INTO cove_baseline_captures VALUES(?,?,?,'products','',0,0,0,?,?,NULL)",
      id,
      c.ownerEpoch,
      c.withdrawalSequence,
      nowMs,
      seed,
    );
    return receipt(get(storage.sql, id));
  });
}
export async function advanceCurrentLegalCapture(
  storage: BaselineStorage,
  db: CatalogDB,
  id: string,
  index: number,
  nowMs: number,
) {
  const sql = storage.sql,
    x = get(sql, id);
  if (
    !baselineInteger(index) ||
    !baselineInteger(nowMs) ||
    !sameClock(sql, x) ||
    nowMs < x.started_ms ||
    nowMs - x.started_ms > 86400000
  )
    throw Error("baseline_capture_stale");
  if (index < x.page_index)
    return { ...receipt(x), page: readCurrentLegalCapturePage(sql, id, index), replayed: true };
  if (index !== x.page_index) throw Error("baseline_capture_index");
  if (x.phase === "sealed") return receipt(x);
  const page = await captureCanonicalLegalInventoryPage(db, sql, {
    phase: x.phase,
    cursor: x.cursor,
    ownerEpoch: x.owner_epoch,
    withdrawalSequence: x.withdrawal_sequence,
    atMs: x.started_ms,
  });
  const sha = await hashLegalBaseline({ kind: page.kind, rows: page.rows });
  const rolling = await hashLegalBaseline({
    prior: x.rolling_sha,
    index: x.page_index,
    kind: page.kind,
    sha256: sha,
  });
  const root = page.done && x.phase === "scopes" ? await hashLegalBaseline(descriptor(x)) : null;
  return storage.transactionSync(() => {
    const current = get(sql, id);
    if (
      !sameClock(sql, current) ||
      current.page_index !== x.page_index ||
      current.phase !== x.phase ||
      current.cursor !== x.cursor
    )
      throw Error("baseline_capture_concurrent");
    if (page.done) {
      if (x.phase === "products") {
        if (x.product_count < 1) throw Error("baseline_capture_empty");
        sql.exec(
          "UPDATE cove_baseline_captures SET phase='scopes',cursor='' WHERE capture_id=?",
          id,
        );
        return receipt(get(sql, id));
      }
      sql.exec(
        "UPDATE cove_baseline_captures SET phase='sealed',inventory_sha=? WHERE capture_id=?",
        root,
        id,
      );
      sql.exec(
        "INSERT INTO cove_baseline_inventory VALUES(1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET capture_id=excluded.capture_id,inventory_sha=excluded.inventory_sha,product_count=excluded.product_count,owner_epoch=excluded.owner_epoch,withdrawal_sequence=excluded.withdrawal_sequence,observed_ms=excluded.observed_ms",
        id,
        root,
        x.product_count,
        x.owner_epoch,
        x.withdrawal_sequence,
        nowMs,
      );
      return receipt(get(sql, id));
    }
    const products = x.product_count + (page.kind === "products" ? page.rows.length : 0),
      scopes = x.scope_count + (page.kind === "scopes" ? page.rows.length : 0);
    if (products > 1000000 || scopes > 1000000 || x.page_index >= 70314)
      throw Error("baseline_capture_bound");
    if (page.kind === "scopes")
      for (const r of page.rows)
        sql.exec(
          "INSERT INTO cove_baseline_capture_scopes VALUES(?,?,?,?,?,?,?,?,?)",
          id,
          r.productId,
          r.territory,
          r.format,
          r.channel,
          r.artifactSha256,
          r.policySha256,
          r.canonicalAllowed ? 1 : 0,
          r.outstandingHold ? 1 : 0,
        );
    sql.exec(
      "INSERT INTO cove_baseline_capture_pages VALUES(?,?,?,?,?)",
      id,
      x.page_index,
      page.kind,
      sha,
      JSON.stringify(page.rows),
    );
    sql.exec(
      "UPDATE cove_baseline_captures SET cursor=?,page_index=page_index+1,product_count=?,scope_count=?,rolling_sha=? WHERE capture_id=?",
      page.nextCursor,
      products,
      scopes,
      rolling,
      id,
    );
    return {
      ...receipt(get(sql, id)),
      page: { index: x.page_index, kind: page.kind, sha256: sha, rows: page.rows },
      replayed: false,
    };
  });
}
