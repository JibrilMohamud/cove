import type { CoveEnv } from "../features/fore/api.server";

/**
 * Off-by-default canonical *metadata intake*, NEVER a playback publisher.
 * Independent licensing is verified upstream; canonical serving must retain
 * separate rights checks, full R2 copy, QA and acoustic release requirements.
 */
type Db = CoveEnv["DB"];
type HandoffEnv = {
  DB: Db;
  FORE_MUSIC_CANONICAL_HANDOFF_ENABLED?: string;
  FORE_MUSIC_CANONICAL_HANDOFF_TOKEN_SHA256?: string;
};
type HandoffRow = {
  id: string;
  seq: number;
  contract_id: string;
  master_id: string | null;
  action: "master_qualified" | "master_revoked" | "contract_revoked";
  payload_json: string;
  contract_status: "active" | "pending" | "revoked";
  contract_expires_at: string;
  contract_evidence_sha256: string;
  publishable: number;
};
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/;
const eventPattern = /^[0-9a-f-]{36}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const when = () => new Date().toISOString();
async function digest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function handoffAuthorized(req: Request, env: HandoffEnv) {
  const expected = env.FORE_MUSIC_CANONICAL_HANDOFF_TOKEN_SHA256;
  const token = req.headers.get("x-cove-music-handoff-token") || "";
  return (
    !!expected &&
    shaPattern.test(expected) &&
    token.length >= 40 &&
    token.length <= 256 &&
    safeEqual(await digest(token), expected)
  );
}
function validate(raw: unknown): HandoffRow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid_music_handoff");
  const e = raw as Partial<HandoffRow>;
  if (
    !Number.isSafeInteger(e.seq) ||
    Number(e.seq) < 1 ||
    typeof e.id !== "string" ||
    !eventPattern.test(e.id) ||
    typeof e.contract_id !== "string" ||
    !idPattern.test(e.contract_id) ||
    !["master_qualified", "master_revoked", "contract_revoked"].includes(String(e.action)) ||
    (e.master_id !== null && (typeof e.master_id !== "string" || !idPattern.test(e.master_id))) ||
    typeof e.payload_json !== "string" ||
    e.payload_json.length > 5000 ||
    !["active", "pending", "revoked"].includes(String(e.contract_status)) ||
    typeof e.contract_expires_at !== "string" ||
    !Number.isFinite(Date.parse(e.contract_expires_at)) ||
    typeof e.contract_evidence_sha256 !== "string" ||
    !shaPattern.test(e.contract_evidence_sha256) ||
    ![0, 1].includes(Number(e.publishable))
  )
    throw new Error("invalid_music_handoff");
  const payload = JSON.parse(e.payload_json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("invalid_music_handoff_payload");
  if (e.action === "master_qualified") {
    const m = payload as Record<string, unknown>;
    if (
      !e.master_id ||
      m.id !== e.master_id ||
      m.contractId !== e.contract_id ||
      typeof m.sha256 !== "string" ||
      !shaPattern.test(m.sha256) ||
      !Number.isSafeInteger(m.bytes) ||
      Number(m.bytes) > 25 * 1024 * 1024 ||
      !["audio/ogg", "audio/mpeg"].includes(String(m.mime)) ||
      !Array.isArray(m.territory) ||
      m.territory.length < 1 ||
      !m.territory.every((c: unknown) => typeof c === "string" && /^[A-Z]{2}$/.test(c))
    )
      throw new Error("invalid_music_master_handoff");
  } else if (e.action === "master_revoked") {
    if (
      !e.master_id ||
      typeof (payload as Record<string, unknown>).reason !== "string" ||
      String((payload as Record<string, unknown>).reason).length < 15
    )
      throw new Error("invalid_music_revocation");
  } else if (
    e.master_id !== null ||
    typeof (payload as Record<string, unknown>).reason !== "string" ||
    String((payload as Record<string, unknown>).reason).length < 15
  )
    throw new Error("invalid_music_revocation");
  return e as HandoffRow;
}

export async function applyCanonicalMusicHandoff(db: Db, raw: unknown) {
  const item = validate(raw);
  const eventHash = await digest(
    JSON.stringify({
      id: item.id,
      seq: item.seq,
      contractId: item.contract_id,
      masterId: item.master_id,
      action: item.action,
      payload: item.payload_json,
    }),
  );
  const prior = await db
    .prepare(
      "SELECT event_id,seq,payload_sha256 FROM music_supply_handoff_events" +
        " WHERE event_id=? OR seq=? LIMIT 2",
    )
    .bind(item.id, item.seq)
    .all<{ event_id: string; seq: number; payload_sha256: string }>();
  if (prior.results.length) {
    if (
      prior.results.length !== 1 ||
      prior.results[0].event_id !== item.id ||
      prior.results[0].payload_sha256 !== eventHash
    )
      throw new Error("music_handoff_conflicting_replay");
    return { replay: true, seq: item.seq, status: "unchanged" };
  }
  // No catalog or entitlement mutation is ever performed by this intake.
  // A stale initial qualification is not publishable even to the private
  // review list; later explicit withdrawals are still allowed to land.
  if (
    item.action === "master_qualified" &&
    (item.publishable !== 1 ||
      item.contract_status !== "active" ||
      Date.parse(item.contract_expires_at) <= Date.now())
  )
    return { skipped: "supplier_rights_inactive", seq: item.seq };
  const at = when();
  const statements = [
    db
      .prepare(
        "INSERT OR IGNORE INTO music_supply_handoff_events" +
          "(event_id,seq,contract_id,master_id,action,payload_sha256,applied_at)" +
          " VALUES(?,?,?,?,?,?,?)",
      )
      .bind(item.id, item.seq, item.contract_id, item.master_id, item.action, eventHash, at),
  ];
  if (item.action === "contract_revoked") {
    statements.push(
      db
        .prepare(
          "INSERT INTO music_supply_handoff_contracts" +
            "(contract_id,status,expires_at,evidence_sha256,last_seq,updated_at)" +
            " SELECT ?,'revoked',?,?,?,? WHERE EXISTS(" +
            " SELECT 1 FROM music_supply_handoff_events" +
            " WHERE event_id=? AND seq=? AND payload_sha256=?)" +
            " ON CONFLICT(contract_id) DO UPDATE SET status='revoked'," +
            " last_seq=MAX(last_seq,excluded.last_seq),updated_at=excluded.updated_at",
        )
        .bind(
          item.contract_id,
          item.contract_expires_at,
          item.contract_evidence_sha256,
          item.seq,
          at,
          item.id,
          item.seq,
          eventHash,
        ),
    );
  } else if (item.action === "master_revoked") {
    statements.push(
      db
        .prepare(
          "INSERT INTO music_supply_handoff_masters" +
            "(master_id,contract_id,status,last_seq,updated_at)" +
            " SELECT ?,?,'revoked',?,? WHERE EXISTS(" +
            " SELECT 1 FROM music_supply_handoff_events" +
            " WHERE event_id=? AND seq=? AND payload_sha256=?)" +
            " ON CONFLICT(master_id) DO UPDATE SET status='revoked'," +
            " last_seq=MAX(last_seq,excluded.last_seq),updated_at=excluded.updated_at",
        )
        .bind(item.master_id, item.contract_id, item.seq, at, item.id, item.seq, eventHash),
    );
  } else {
    const m = JSON.parse(item.payload_json) as Record<string, unknown>;
    statements.push(
      db
        .prepare(
          "INSERT INTO music_supply_handoff_contracts" +
            "(contract_id,status,expires_at,evidence_sha256,last_seq,updated_at)" +
            " SELECT ?,'active',?,?,?,? WHERE EXISTS(" +
            " SELECT 1 FROM music_supply_handoff_events" +
            " WHERE event_id=? AND seq=? AND payload_sha256=?)" +
            " ON CONFLICT(contract_id) DO UPDATE SET" +
            " last_seq=MAX(last_seq,excluded.last_seq)," +
            " expires_at=excluded.expires_at,updated_at=excluded.updated_at" +
            " WHERE music_supply_handoff_contracts.status!='revoked'" +
            " AND excluded.last_seq>music_supply_handoff_contracts.last_seq",
        )
        .bind(
          item.contract_id,
          item.contract_expires_at,
          item.contract_evidence_sha256,
          item.seq,
          at,
          item.id,
          item.seq,
          eventHash,
        ),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO music_supply_handoff_masters" +
            "(master_id,contract_id,master_sha256,metadata_json,status,last_seq,updated_at)" +
            " SELECT ?,?,?,?,?,?,? WHERE EXISTS" +
            " (SELECT 1 FROM music_supply_handoff_contracts" +
            " WHERE contract_id=? AND status='active' AND expires_at>?)" +
            " AND EXISTS(SELECT 1 FROM music_supply_handoff_events" +
            " WHERE event_id=? AND seq=? AND payload_sha256=?)" +
            " ON CONFLICT(master_id) DO UPDATE SET" +
            " last_seq=excluded.last_seq WHERE music_supply_handoff_masters.status!='revoked'" +
            " AND excluded.last_seq>music_supply_handoff_masters.last_seq",
        )
        .bind(
          item.master_id,
          item.contract_id,
          m.sha256,
          item.payload_json,
          "pending_media",
          item.seq,
          at,
          item.contract_id,
          at,
          item.id,
          item.seq,
          eventHash,
        ),
    );
  }
  await db.batch(statements);
  // The preliminary replay lookup is advisory. On competing concurrent writes,
  // a different event may have won the UNIQUE seq/id slot after that lookup.
  // Never acknowledge such a collision as a committed canonical handoff.
  const committed = await db.prepare(
    "SELECT event_id,payload_sha256 FROM music_supply_handoff_events WHERE seq=?",
  ).bind(item.seq).first<{ event_id:string; payload_sha256:string }>();
  if (committed?.event_id !== item.id || committed.payload_sha256 !== eventHash)
    throw new Error("music_handoff_conflicting_replay");
  return { seq: item.seq, recorded: true, status: "private_metadata_only" };
}

export async function handleCanonicalMusicHandoff(
  req: Request,
  env: HandoffEnv,
  admit?: () => Promise<{ allowed: boolean; reason?: string; probeMs?: number }>,
) {
  if (env.FORE_MUSIC_CANONICAL_HANDOFF_ENABLED !== "1")
    return Response.json({ error: "music_canonical_handoff_disabled" }, { status: 403 });
  if (!(await handoffAuthorized(req, env)))
    return Response.json({ error: "music_canonical_handoff_unauthorized" }, { status: 401 });
  // Only a fully authorized publisher reaches the shared D1 admission probe.
  // Deferred background events remain replayable in the isolated source ledger.
  if (admit) {
    const gate = await admit();
    if (!gate.allowed)
      return Response.json(
        { error: "music_handoff_primary_d1_busy", reason: gate.reason, probeMs: gate.probeMs },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
  }
  try {
    if (Number(req.headers.get("content-length") || 0) > 10000)
      return Response.json({ error: "music_handoff_too_large" }, { status: 413 });
    const body = await req.text();
    if (body.length > 10000)
      return Response.json({ error: "music_handoff_too_large" }, { status: 413 });
    const result = await applyCanonicalMusicHandoff(env.DB, JSON.parse(body));
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "invalid_or_conflicting_music_handoff" }, { status: 409 });
  }
}
