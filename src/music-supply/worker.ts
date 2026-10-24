import { privateMusicCandidates } from "./catalog-projection";
import { handleMusicAnalysis } from "./analysis";
import { QUIET_READING_POLICY } from "../features/fore/quiet-reading-score";
import {
  validateMusicContract,
  validateMusicMaster,
  validateMusicQuality,
  MUSIC_SUPPLY_MAX_BATCH,
  type MusicSupplyContract,
  type MusicMasterManifest,
} from "./policy";

type D1 = {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
    first<T = Record<string, unknown>>(): Promise<T | null>;
  };
  batch(statements: unknown[]): Promise<unknown>;
};
type R2Object = { size: number; checksums?: { sha256?: ArrayBuffer | string } };
type R2 = {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
  put(key: string, content: ReadableStream | string | Uint8Array, opts?: unknown): Promise<unknown>;
};
export type MusicSupplyEnv = {
  MUSIC_DB?: D1;
  MUSIC_BUCKET?: R2;
  MUSIC_SUPPLY_ENABLED?: string;
  MUSIC_OPERATOR_TOKEN_SHA256?: string;
  MUSIC_LICENSE_REVIEWER_TOKEN_SHA256?: string;
  MUSIC_INGEST_TOKEN_SHA256?: string;
  MUSIC_QA_TOKEN_SHA256?: string;
  MUSIC_ANALYSIS_TOKEN_SHA256?: string;
  MUSIC_ANALYSIS_ENABLED?: string;
  MUSIC_AUTO_QUIET_APPROVAL?: string;
};

function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
const shaPattern = /^[0-9a-f]{64}$/;
async function hash(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function authorized(req: Request, expected: string | undefined): Promise<boolean> {
  if (!expected || !shaPattern.test(expected)) return false;
  const token = req.headers.get("authorization");
  if (!token?.startsWith("Bearer ") || token.length > 512 || token.length < 40) return false;
  const actual = await hash(token.slice(7));
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++)
    mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return mismatch === 0;
}
async function readLimited(req: Request, limit: number): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length") || 0) > limit)
    throw Error("music_payload_too_large");
  const reader = req.body?.getReader();
  if (!reader) throw Error("music_missing_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Error("music_payload_too_large");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
async function json(req: Request, maximum = 16000): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readLimited(req, maximum)));
}
async function contract(
  env: MusicSupplyEnv,
  contractId: string,
): Promise<MusicSupplyContract | null> {
  const r = await env
    .MUSIC_DB!.prepare("SELECT * FROM music_contracts WHERE id=?")
    .bind(contractId)
    .first<Record<string, string>>();
  if (!r) return null;
  const v = JSON.parse(r.rights_json) as MusicSupplyContract;
  if (!["pending", "active", "revoked"].includes(r.status))
    throw Error("music_corrupt_contract_status");
  return {
    ...v,
    status: r.status as MusicSupplyContract["status"],
    expiresAt: r.expires_at,
  };
}
function objectHash(head: R2Object | null): string | null {
  const h = head?.checksums?.sha256;
  if (!h) return null;
  if (typeof h === "string") return h.toLowerCase();
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function requireObject(bucket: R2, key: string, bytes: number | null, expectedSha: string) {
  const head = await bucket.head(key);
  if (!head || (bytes !== null && head.size !== bytes) || objectHash(head) !== expectedSha)
    throw Error("music_private_r2_checksum_mismatch");
}
const now = () => new Date().toISOString();
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/;
const masterKey = (sha: string, mime: string) =>
  "music-supply/masters/" + sha + (mime === "audio/mpeg" ? ".mp3" : ".ogg");

type MasterRow = {
  id: string;
  contract_id: string;
  sha256: string;
  bytes: number;
  mime: string;
  manifest_json: string;
  status: string;
  storage_key: string | null;
};
async function master(env: MusicSupplyEnv, masterId: string) {
  return env
    .MUSIC_DB!.prepare("SELECT * FROM music_masters WHERE id=?")
    .bind(masterId)
    .first<MasterRow>();
}
async function route(request: Request, env: MusicSupplyEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === "/health" && method === "GET")
    return response({ healthy: true, processingEnabled: env.MUSIC_SUPPLY_ENABLED === "1" });
  // This worker has NO binding to Cove's production primary D1, Vercel,
  // customer KV or authenticated media gateway. Disabled in all deployments
  // unless an operator deliberately enables the isolated pipeline.
  if (env.MUSIC_SUPPLY_ENABLED !== "1" || !env.MUSIC_DB || !env.MUSIC_BUCKET)
    return response({ error: "music_supply_disabled" }, 503);
  const admin = await authorized(request, env.MUSIC_OPERATOR_TOKEN_SHA256);
  const ingest = await authorized(request, env.MUSIC_INGEST_TOKEN_SHA256);
  const reviewer = await authorized(request, env.MUSIC_LICENSE_REVIEWER_TOKEN_SHA256);
  const qa = await authorized(request, env.MUSIC_QA_TOKEN_SHA256);
  const analyst = await authorized(request, env.MUSIC_ANALYSIS_TOKEN_SHA256);
  if (
    !env.MUSIC_OPERATOR_TOKEN_SHA256 ||
    env.MUSIC_OPERATOR_TOKEN_SHA256 === env.MUSIC_LICENSE_REVIEWER_TOKEN_SHA256 ||
    env.MUSIC_OPERATOR_TOKEN_SHA256 === env.MUSIC_INGEST_TOKEN_SHA256 ||
    env.MUSIC_QA_TOKEN_SHA256 === env.MUSIC_INGEST_TOKEN_SHA256 ||
    (env.MUSIC_ANALYSIS_ENABLED === "1" &&
      (!env.MUSIC_ANALYSIS_TOKEN_SHA256 ||
        !shaPattern.test(env.MUSIC_ANALYSIS_TOKEN_SHA256) ||
        [env.MUSIC_OPERATOR_TOKEN_SHA256, env.MUSIC_INGEST_TOKEN_SHA256,
         env.MUSIC_QA_TOKEN_SHA256, env.MUSIC_LICENSE_REVIEWER_TOKEN_SHA256].includes(env.MUSIC_ANALYSIS_TOKEN_SHA256)))
  )
    return response({ error: "music_role_separation_required" }, 503);

  const analysisResponse = await handleMusicAnalysis(request, env, analyst, admin);
  if (analysisResponse) return analysisResponse;

  const evidenceMatch = /^\/v1\/evidence\/([a-zA-Z0-9._:-]{3,120})$/.exec(path);
  if (method === "POST" && evidenceMatch) {
    if (!admin) return response({ error: "unauthorized" }, 401);
    const bytes = await readLimited(request, 65000);
    const metadata = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (
      metadata.contractId !== evidenceMatch[1] ||
      typeof metadata.licensor !== "string" ||
      typeof metadata.authorizingInstrument !== "string" ||
      metadata.commercialStreaming !== true ||
      metadata.masterRights !== true ||
      metadata.compositionRights !== true
    )
      return response({ error: "music_evidence_incomplete" }, 422);
    const digest = await hash(bytes);
    const key = "music-supply/evidence/" + evidenceMatch[1] + "/" + digest + ".json";
    await env.MUSIC_BUCKET.put(key, bytes, {
      sha256: digest,
      httpMetadata: { contentType: "application/json" },
    });
    return response({ evidenceKey: key, evidenceSha256: digest }, 201);
  }

  if (path === "/v1/contracts" && method === "POST") {
    if (!admin) return response({ error: "unauthorized" }, 401);
    const value = validateMusicContract(await json(request));
    await requireObject(env.MUSIC_BUCKET, value.evidenceKey, null, value.evidenceSha256);
    const at = now();
    const result = await env.MUSIC_DB.prepare(
      "INSERT OR IGNORE INTO music_contracts(id,provider,status,licensed_origin,allowed_territories_json,expires_at,evidence_key,evidence_sha256,rights_json,created_at,updated_at) VALUES(?,?,'pending',?,?,?,?,?,?,?,?)",
    )
      .bind(
        value.id,
        value.provider,
        value.licensedOrigin,
        JSON.stringify(value.territories),
        value.expiresAt,
        value.evidenceKey,
        value.evidenceSha256,
        JSON.stringify(value),
        at,
        at,
      )
      .run();
    return response(
      { contractId: value.id, status: "pending", created: result.meta?.changes === 1 },
      201,
    );
  }

  const activate = /^\/v1\/contracts\/([a-zA-Z0-9._:-]{3,120})\/activate$/.exec(path);
  if (activate && method === "POST") {
    if (!reviewer) return response({ error: "license_reviewer_required" }, 401);
    const r = await env.MUSIC_DB.prepare("SELECT * FROM music_contracts WHERE id=?")
      .bind(activate[1])
      .first<Record<string, string>>();
    if (!r || r.status !== "pending" || Date.parse(r.expires_at) <= Date.now())
      return response({ error: "music_contract_not_pending" }, 409);
    await requireObject(env.MUSIC_BUCKET, r.evidence_key, null, r.evidence_sha256);
    const payload = (await json(request, 8000)) as Record<string, unknown>;
    if (
      typeof payload.reviewer !== "string" ||
      payload.reviewer.length < 4 ||
      typeof payload.reviewReference !== "string" ||
      payload.reviewReference.length < 16 ||
      payload.evidenceSha256 !== r.evidence_sha256 ||
      payload.confirmedFiveLayers !== true
    )
      return response({ error: "music_independent_rights_review_required" }, 422);
    const at = now(),
      eventId = crypto.randomUUID();
    await env.MUSIC_DB.batch([
      env.MUSIC_DB.prepare(
        "UPDATE music_contracts SET status='active',reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=? AND status='pending' AND expires_at>?",
      ).bind(payload.reviewer, at, at, activate[1], at),
      env.MUSIC_DB.prepare(
        "INSERT INTO music_events(id,contract_id,master_id,type,payload_json,created_at) SELECT ?,id,NULL,'contract_activated',?,? FROM music_contracts WHERE id=? AND status='active' AND reviewed_at=?",
      ).bind(eventId, JSON.stringify({ reference: payload.reviewReference }), at, activate[1], at),
    ]);
    return response({ contractId: activate[1], status: "active" });
  }

  // The ingestion credential cannot impersonate QA. The independent audio
  // analyst has read-only access to staged originals, never to customer media.
  if (path === "/v1/qa/staged" && method === "GET") {
    if (!qa) return response({ error: "music_qa_identity_required" }, 401);
    const query = new URL(request.url).searchParams;
    const after = query.get("after") || "";
    if (after.length > 120 || (after && !idPattern.test(after)))
      return response({ error: "music_invalid_cursor" }, 400);
    const rows = (
      await env.MUSIC_DB.prepare(
        "SELECT m.id,m.sha256,m.bytes,m.mime,m.manifest_json FROM music_masters m" +
          " JOIN music_contracts c ON c.id=m.contract_id" +
          " WHERE m.status='staged' AND c.status='active' AND c.expires_at>? AND m.id>?" +
          " ORDER BY m.id LIMIT ?",
      )
        .bind(now(), after, MUSIC_SUPPLY_MAX_BATCH)
        .all<Record<string, unknown>>()
    ).results;
    return response({
      items: rows,
      nextCursor: rows.length ? String(rows[rows.length - 1].id) : after,
    });
  }
  const qaMasterAudio = /^\/v1\/qa\/masters\/([a-zA-Z0-9._:-]{3,120})\/audio$/.exec(path);
  if (qaMasterAudio && method === "GET") {
    if (!qa) return response({ error: "music_qa_identity_required" }, 401);
    const r = await master(env, qaMasterAudio[1]);
    if (!r || r.status !== "staged" || !r.storage_key)
      return response({ error: "music_qa_master_unavailable" }, 404);
    const c = await contract(env, r.contract_id);
    if (!c || c.status !== "active" || Date.parse(c.expiresAt) <= Date.now())
      return response({ error: "music_qa_master_unavailable" }, 404);
    await requireObject(env.MUSIC_BUCKET, r.storage_key, r.bytes, r.sha256);
    const object = await env.MUSIC_BUCKET.get(r.storage_key);
    if (!object || object.size !== r.bytes)
      return response({ error: "music_qa_master_unavailable" }, 404);
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": r.mime,
        "content-length": String(r.bytes),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  if (path === "/v1/masters" && method === "POST") {
    if (!ingest) return response({ error: "unauthorized" }, 401);
    const data = (await json(request)) as Record<string, unknown>;
    const c = await contract(env, String(data?.contractId || ""));
    if (!c) return response({ error: "music_unknown_contract" }, 404);
    const value = validateMusicMaster(data, c);
    const at = now();
    const stored = await env.MUSIC_DB.prepare(
      "INSERT OR IGNORE INTO music_masters(id,contract_id,sha256,manifest_json,status,bytes,mime,created_at,updated_at) VALUES(?,?,?,?,'quarantined',?,?,?,?)",
    )
      .bind(
        value.id,
        value.contractId,
        value.sha256,
        JSON.stringify(value),
        value.bytes,
        value.mime,
        at,
        at,
      )
      .run();
    if (stored.meta?.changes !== 1) {
      const before = await master(env, value.id);
      if (
        !before ||
        before.sha256 !== value.sha256 ||
        before.contract_id !== value.contractId ||
        before.manifest_json !== JSON.stringify(value)
      )
        return response({ error: "music_master_conflict" }, 409);
    }
    return response(
      { id: value.id, status: "quarantined", created: stored.meta?.changes === 1 },
      201,
    );
  }

  const audio = /^\/v1\/masters\/([a-zA-Z0-9._:-]{3,120})\/audio$/.exec(path);
  if (audio && method === "PUT") {
    if (!ingest) return response({ error: "unauthorized" }, 401);
    const r = await master(env, audio[1]);
    if (!r || !["quarantined", "staged"].includes(r.status))
      return response({ error: "music_master_not_staged" }, 409);
    const c = await contract(env, r.contract_id);
    if (!c || c.status !== "active" || Date.parse(c.expiresAt) <= Date.now())
      return response({ error: "music_contract_not_active" }, 409);
    if (
      Number(request.headers.get("content-length")) !== r.bytes ||
      !request.body ||
      request.headers.get("content-type")?.split(";")[0] !== r.mime
    )
      return response({ error: "music_audio_size_or_mime_mismatch" }, 422);
    const key = masterKey(r.sha256, r.mime);
    await env.MUSIC_BUCKET.put(key, request.body, {
      sha256: r.sha256,
      httpMetadata: { contentType: r.mime },
      customMetadata: { sha256: r.sha256, source: "verified_supplier_manifest" },
    });
    await requireObject(env.MUSIC_BUCKET, key, r.bytes, r.sha256);
    await env.MUSIC_DB.prepare(
      "UPDATE music_masters SET storage_key=?,status='staged',updated_at=? WHERE id=? AND sha256=? AND status IN ('quarantined','staged')",
    )
      .bind(key, now(), r.id, r.sha256)
      .run();
    return response({ id: r.id, status: "staged" });
  }

  const attestation = /^\/v1\/masters\/([a-zA-Z0-9._:-]{3,120})\/quality$/.exec(path);
  if (attestation && method === "POST") {
    if (!qa) return response({ error: "music_independent_quality_attestation_required" }, 401);
    const r = await master(env, attestation[1]);
    if (!r || r.status !== "staged" || !r.storage_key)
      return response({ error: "music_master_not_ready_for_qa" }, 409);
    const c = await contract(env, r.contract_id);
    if (!c || c.status !== "active" || Date.parse(c.expiresAt) <= Date.now())
      return response({ error: "music_contract_not_active" }, 409);
    await requireObject(env.MUSIC_BUCKET, r.storage_key, r.bytes, r.sha256);
    const report = validateMusicQuality(await json(request, 8000), r.sha256, r.bytes);
    const text = JSON.stringify(report);
    const reportDigest = await hash(text);
    const key = "music-supply/quality/" + r.sha256 + "/" + reportDigest + ".json";
    await env.MUSIC_BUCKET.put(key, text, {
      sha256: reportDigest,
      httpMetadata: { contentType: "application/json" },
    });
    const at = now(),
      eventId = crypto.randomUUID();
    await env.MUSIC_DB.batch([
      env.MUSIC_DB.prepare(
        "UPDATE music_masters SET quality_key=?,status='quality_passed',updated_at=? WHERE id=? AND sha256=? AND status='staged' AND EXISTS(SELECT 1 FROM music_contracts c WHERE c.id=music_masters.contract_id AND c.status='active' AND c.expires_at>?)",
      ).bind(key, at, r.id, r.sha256, at),
      // Enabled cohorts cannot enter the handoff merely by passing FFmpeg.
      // The immutable exact-master job must separately finish quietness QA.
      ...(env.MUSIC_ANALYSIS_ENABLED === "1"
        ? [
            env.MUSIC_DB.prepare(
              "INSERT OR IGNORE INTO music_analysis_jobs(master_id,policy,master_sha256,available_at,created_at,updated_at)" +
                " SELECT id,?,?,?,?,? FROM music_masters WHERE id=? AND sha256=?" +
                " AND status='quality_passed' AND updated_at=?",
            ).bind(QUIET_READING_POLICY, r.sha256, at, at, at, r.id, r.sha256, at),
          ]
        : [
            env.MUSIC_DB.prepare(
              "INSERT INTO music_publication_outbox(id,contract_id,master_id,action,payload_json,created_at) SELECT ?,contract_id,id,'master_qualified',manifest_json,? FROM music_masters WHERE id=? AND status='quality_passed' AND updated_at=?",
            ).bind(eventId, at, r.id, at),
          ]),
    ]);
    return response({
      id: r.id,
      status: "quality_passed",
      analysisQueued: env.MUSIC_ANALYSIS_ENABLED === "1",
      canonicalPublished: false,
    }, 202);
  }

  // Explicit per-master withdrawal precedes any R2 cleanup. The future
  // canonical publisher must consume the durable removal event first.
  const masterRevoke = /^\/v1\/masters\/([a-zA-Z0-9._:-]{3,120})\/revoke$/.exec(path);
  if (masterRevoke && method === "POST") {
    if (!reviewer) return response({ error: "license_reviewer_required" }, 401);
    const record = await master(env, masterRevoke[1]);
    if (!record) return response({ error: "music_master_not_found" }, 404);
    const reason = (await json(request, 1000)) as Record<string, unknown>;
    if (typeof reason.reason !== "string" || reason.reason.length < 15)
      return response({ error: "music_revocation_reason_required" }, 422);
    const at = now(),
      eventId = crypto.randomUUID();
    await env.MUSIC_DB.batch([
      env.MUSIC_DB.prepare(
        "UPDATE music_masters SET status='revoked',updated_at=? WHERE id=? AND status!='revoked'",
      ).bind(at, masterRevoke[1]),
      env.MUSIC_DB.prepare(
        "INSERT INTO music_publication_outbox(id,contract_id,master_id,action,payload_json,created_at) SELECT ?,contract_id,id,'master_revoked',?,? FROM music_masters WHERE id=? AND status='revoked' AND updated_at=?",
      ).bind(eventId, JSON.stringify({ reason: reason.reason }), at, masterRevoke[1], at),
    ]);
    return response({
      id: masterRevoke[1],
      status: "revoked",
      requiresCanonicalRevocation: true,
    });
  }

  const contractRevoke = /^\/v1\/contracts\/([a-zA-Z0-9._:-]{3,120})\/revoke$/.exec(path);
  if (contractRevoke && method === "POST") {
    if (!reviewer) return response({ error: "license_reviewer_required" }, 401);
    const reason = (await json(request, 1000)) as Record<string, unknown>;
    if (typeof reason.reason !== "string" || reason.reason.length < 15)
      return response({ error: "music_revocation_reason_required" }, 422);
    const at = now(),
      id = crypto.randomUUID();
    await env.MUSIC_DB.batch([
      env.MUSIC_DB.prepare(
        "UPDATE music_contracts SET status='revoked',updated_at=? WHERE id=? AND status!='revoked'",
      ).bind(at, contractRevoke[1]),
      env.MUSIC_DB.prepare(
        "INSERT INTO music_publication_outbox(id,contract_id,master_id,action,payload_json,created_at) SELECT ?,id,NULL,'contract_revoked',?,? FROM music_contracts WHERE id=? AND status='revoked' AND updated_at=?",
      ).bind(id, JSON.stringify({ reason: reason.reason }), at, contractRevoke[1], at),
    ]);
    return response({
      contractId: contractRevoke[1],
      status: "revoked",
      requiresCanonicalRevocation: true,
    });
  }

  if (path === "/v1/operator/preview-catalog" && method === "GET") {
    if (!admin) return response({ error: "unauthorized" }, 401);
    const params = new URL(request.url).searchParams;
    return response(
      await privateMusicCandidates(
        env.MUSIC_DB,
        env.MUSIC_BUCKET,
        params.get("territory") || "US",
        params.get("after") || "",
        Number(params.get("limit") || 8),
        env.MUSIC_ANALYSIS_ENABLED === "1",
      ),
    );
  }

  if (path === "/v1/operator/outbox" && method === "GET") {
    if (!admin) return response({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const after = url.searchParams.get("after") || "0";
    if (!/^(0|[1-9][0-9]{0,14})$/.test(after))
      return response({ error: "music_invalid_cursor" }, 400);
    const requestedLimit = Number(url.searchParams.get("limit") || 4);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)
      return response({ error: "music_invalid_limit" }, 400);
    const limit = Math.min(MUSIC_SUPPLY_MAX_BATCH, requestedLimit);
    // An old qualified event is never independently publishable after its
    // parent contract has expired or been revoked. The downstream authority
    // must separately check current rights and consume retraction events.
    const rows = (
      await env.MUSIC_DB.prepare(
        "SELECT o.*,c.status contract_status,c.expires_at contract_expires_at," +
          " c.evidence_sha256 contract_evidence_sha256," +
          " CASE WHEN o.action='master_qualified' AND c.status='active' AND c.expires_at>?" +
          " AND EXISTS(SELECT 1 FROM music_masters m WHERE m.id=o.master_id AND m.status='quality_passed')" +
          (env.MUSIC_ANALYSIS_ENABLED === "1"
            ? " AND EXISTS(SELECT 1 FROM music_analysis_jobs j JOIN music_masters m ON m.id=j.master_id" +
              " WHERE j.master_id=o.master_id AND j.policy='" + QUIET_READING_POLICY + "'" +
              " AND j.master_sha256=m.sha256 AND j.status='approved')"
            : "") +
          " THEN 1 ELSE 0 END publishable" +
          " FROM music_publication_outbox o JOIN music_contracts c ON c.id=o.contract_id" +
          " WHERE o.seq>? ORDER BY o.seq LIMIT ?",
      )
        .bind(now(), Number(after), limit)
        .all<Record<string, unknown>>()
    ).results;
    return response({
      items: rows,
      nextCursor: rows.length ? String(rows[rows.length - 1].seq) : after,
      note: "Unsigned operator handoff only; canonical publisher MUST recheck rights and revocation.",
    });
  }

  return response({ error: "not_found" }, 404);
}
export default {
  async fetch(request: Request, env: MusicSupplyEnv) {
    try {
      return await route(request, env);
    } catch (error) {
      // No tokens, legal docs, master URLs or body content are logged.
      const code = String(error instanceof Error ? error.message : error);
      const status = /not_active|not_staged|not_pending/.test(code)
        ? 409
        : /payload|source|expired|rights_layers|quality|invalid|covered|mismatch/.test(code)
          ? 422
          : 500;
      return response(
        { error: code.startsWith("music_") ? code : "music_processing_failed" },
        status,
      );
    }
  },
};
