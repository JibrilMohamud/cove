/* eslint-disable prettier/prettier -- Module will be normalized when the soundtrack review UI stabilizes. */
import type { CoveEnv } from "./api.server";
import { ApiError, json, readBody } from "./service";
import { requireServiceScope } from "./privileged-access.server";
import { requireStaffPermission } from "./moderation.server";
import type { CoveIdentity } from "./auth.server";
import { soundtrackDossierSchema, soundtrackQualitySchema, qualityPasses } from "./soundtrack-review";

/** Rights-reviewed recording library. This is intentionally independent of audiobooks.
 * Discovery only queues candidates. Only an accountable, evidence-backed review may authorize
 * copying an individual performance to R2 or publicly serving it.
 */
const CATEGORIES = [
  { name: "Audio files of classical music for piano", period: "mixed", instrument: "piano" },
  { name: "Audio files of Baroque period classical music", period: "baroque", instrument: "" },
  { name: "Audio files of Classical period classical music", period: "classical", instrument: "" },
  { name: "Audio files of Romantic period classical music", period: "romantic", instrument: "" },
  { name: "Audio files of renaissance period classical music", period: "renaissance", instrument: "" },
  { name: "Audio files of medieval period classical music", period: "medieval", instrument: "" },
] as const;
const MAX_DISCOVERED = 750;
const MAX_BYTES = 25 * 1024 * 1024;
const API = "https://commons.wikimedia.org/w/api.php";
const AGENT = "CoveSoundtracks/0.2 (https://cove-puce-theta.vercel.app/help; rights-review)";
type CommonsInfo = {
  mime?: string;
  size?: number;
  sha1?: string;
  url?: string;
  descriptionurl?: string;
  extmetadata?: Record<string, { value?: string }>;
};
type CommonsPage = { pageid?: number; title?: string; imageinfo?: CommonsInfo[];
  revisions?: { revid: number; timestamp: string; slots?: { main?: { content?: string } } }[] };
type CommonsReply = {
  query?: { pages?: Record<string, CommonsPage> };
  continue?: { gcmcontinue?: string };
  error?: { code?: string };
};
export type SoundtrackRow = {
  id: string; source_title: string; title: string; source_page_url: string;
  source_file_url: string; source_sha1: string; source_size: number; mime: string;
  performer: string; composer: string; license_code: string; license_url: string;
  license_statement: string; attribution_text: string; period: string;
  instruments_json: string; moods_json: string; energy: number | null;
  has_vocals: number | null; status: string; reviewed_at: string | null;
  allowed_territories_json: string; storage_key: string | null;
  storage_bytes: number | null; evidence_json: string; dossier_json: string;
  quality_status: string; quality_report_json: string; source_snapshot_key: string | null;
  review_version: number; updated_at: string; reviewed_by: string | null;
};
const clearText = (value: unknown, max = 300) =>
  String(value || "").replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp);/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);

function normalizeLicenseUrl(value: string) {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.hostname !== "creativecommons.org" ||
        u.username || u.password || u.port || u.search || u.hash) return "";
    return "https://creativecommons.org" + u.pathname.replace(/\/(?:deed(?:\.[a-z-]+)?)\/?$/i, "/")
      .replace(/\/?$/, "/");
  } catch { return ""; }
}
function licensed(info: CommonsInfo) {
  const m = info.extmetadata || {};
  const stated = clearText(m.LicenseShortName?.value, 80);
  const rawLink = clearText(m.LicenseUrl?.value, 300);
  const link = normalizeLicenseUrl(rawLink);
  if (/^CC0(?: 1\.0)?$/i.test(stated) && link === "https://creativecommons.org/publicdomain/zero/1.0/")
    return { code: "CC0", link, statement: stated };
  const by = /^CC BY ([234](?:\.0|\.5))$/i.exec(stated);
  if (by && link === "https://creativecommons.org/licenses/by/" + by[1] + "/")
    return { code: "CC-BY", link, statement: stated };
  // BY-SA allows commercial redistribution of the original recording, but also
  // requires attribution, a license link, indication of modifications and respect
  // for share-alike/no-additional-restrictions. Candidate status is NOT approval.
  const sa = /^CC BY-SA ([234](?:\.0|\.5))$/i.exec(stated);
  if (sa && link === "https://creativecommons.org/licenses/by-sa/" + sa[1] + "/")
    return { code: "CC-BY-SA", link, statement: stated };
  // Commons often supplies no LicenseUrl for a plain PD tag. This is a SOURCE
  // CLAIM, not legal evidence that an arrangement, performance or master is free.
  if (/^(public domain|pd)$/i.test(stated) && !rawLink &&
      /^false$/i.test(clearText(m.Copyrighted?.value, 10)))
    return { code: "PD", link: "https://commons.wikimedia.org/wiki/Commons:Licensing", statement: "Public domain (Commons claim)" };
  return null;
}
function playableMime(info: CommonsInfo) {
  if (info.mime === "application/ogg" || info.mime === "audio/ogg") return "audio/ogg";
  if (info.mime === "audio/mpeg") return "audio/mpeg";
  return null;
}
function sourceFileUrl(info: CommonsInfo) {
  try {
    const u = new URL(String(info.url || ""));
    if (u.protocol !== "https:" || u.hostname !== "upload.wikimedia.org" ||
        u.username || u.password || u.port || u.hash || !/^\/wikipedia\/commons\//.test(u.pathname) ||
        [...u.searchParams.keys()].some(key => !/^utm_[a-z0-9_]+$/i.test(key))) return null;
    // MediaWiki adds analytics query parameters to immutable file URLs; never
    // include those in the stored media identity or outbound download request.
    u.search = "";
    return u.toString();
  } catch { return null; }
}
function profile(title: string, category: (typeof CATEGORIES)[number]) {
  const t = title.toLowerCase();
  let moods: string[] = [];
  let energy: number | null = null;
  if (/nocturne|gnossienne|gymnop.die|lento|adagio|lullaby|berceuse/.test(t)) {
    moods = ["reflective", "gentle"]; energy = 0.25;
  } else if (/allegro|presto|vivace|toccata|march|scherzo/.test(t)) {
    moods = ["animated", "dramatic"]; energy = 0.8;
  } else if (/requiem|elegy|funeral|lament/.test(t)) {
    moods = ["solemn", "melancholic"]; energy = 0.35;
  } else if (/waltz|valse|minuet|menuet/.test(t)) {
    moods = ["graceful", "playful"]; energy = 0.55;
  }
  const instruments = category.instrument ? [category.instrument] : [];
  const hasVocals = /\b(?:vocal|choir|choral|song|aria|cantata)\b/.test(t) ? 1 : null;
  return { moods, energy, instruments, hasVocals };
}
async function commonsRequest(params: URLSearchParams): Promise<CommonsReply> {
  params.set("action", "query");
  params.set("format", "json");
  params.set("formatversion", "2");
  params.set("maxlag", "5");
  const result = await fetch(API + "?" + params.toString(), {
    headers: { "User-Agent": AGENT, "Api-User-Agent": AGENT, "Accept": "application/json" },
    redirect: "manual", signal: AbortSignal.timeout(15_000),
  });
  if (!result.ok) throw new Error("Commons metadata unavailable: HTTP " + result.status);
  const data = await result.json() as CommonsReply;
  if (data.error) throw new Error("Commons metadata unavailable: " + data.error.code);
  return data;
}
function validCandidate(page: CommonsPage) {
  const info = page.imageinfo?.[0];
  const mime = info && playableMime(info);
  const size = Number(info?.size);
  const sha1 = String(info?.sha1 || "").toLowerCase();
  const license = info && licensed(info);
  if (!page.pageid || !page.title?.startsWith("File:") || !mime || !license ||
      !Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES ||
      !/^[a-f0-9]{40}$/.test(sha1) || !sourceFileUrl(info!)) return null;
  const title = clearText(page.title.slice(5).replace(/\.(ogg|oga|mp3)$/i, ""), 250);
  const sourcePage = "https://commons.wikimedia.org/wiki/" + encodeURIComponent(page.title.replace(/ /g, "_"));
  const performer = clearText(info!.extmetadata?.Artist?.value, 400);
  const attribution = title + " — " + (performer || "performer unverified") + " · " + license.statement;
  return { id: "cm_" + page.pageid, title, sourcePage, info: info!,
    mediaUrl: sourceFileUrl(info!)!, mime, size, sha1, license, performer, attribution };
}
export async function discoverSoundtrackCandidates(env: CoveEnv) {
  const state = await env.DB.prepare("SELECT * FROM soundtrack_ingestion_state WHERE id=1").first<{
    category_index:number; continuation:string; discovered:number; last_discovery_at:string; category_cursors_json:string
  }>();
  if (!state || state.discovered >= MAX_DISCOVERED)
    return { skipped: "complete", discovered: Number(state?.discovered || 0) };
  const cursors = JSON.parse(state.category_cursors_json || "{}") as Record<string,string>;
  if (CATEGORIES.every(cat => cursors[cat.name] === "DONE"))
    return { skipped: "categories_exhausted", discovered: Number(state.discovered) };
  const now = new Date().toISOString();
  if (state.last_discovery_at && Date.now() - Date.parse(state.last_discovery_at) < 8 * 60_000)
    return { skipped: "cadence" };
  const token = crypto.randomUUID();
  const lease = await env.DB.prepare(
    "UPDATE soundtrack_ingestion_state SET lease_token=?,lease_until=? WHERE id=1 AND lease_until<? RETURNING id",
  ).bind(token, new Date(Date.now()+90_000).toISOString(), now).first<{ id:number }>();
  if (!lease) return { skipped: "leased" };
  try {
    let categoryIndex = Number(state.category_index) % CATEGORIES.length;
    for (let index = 0; index < CATEGORIES.length; index++) {
      if (cursors[CATEGORIES[categoryIndex].name] !== "DONE") break;
      categoryIndex = (categoryIndex + 1) % CATEGORIES.length;
    }
    const category = CATEGORIES[categoryIndex];
    const params = new URLSearchParams({
      generator: "categorymembers", gcmtitle: "Category:" + category.name,
      gcmtype: "file", gcmlimit: "50", prop: "imageinfo",
      iiprop: "url|mime|size|sha1|extmetadata",
    });
    if (cursors[category.name]) params.set("gcmcontinue", cursors[category.name]);
    const data = await commonsRequest(params);
    let added = 0;
    const pages = Object.values(data.query?.pages || {}).sort((a,b) => (a.pageid || 0)-(b.pageid || 0));
    for (const page of pages) {
      if (Number(state.discovered) + added >= MAX_DISCOVERED) break;
      const c = validCandidate(page);
      if (!c) continue;
      const tags = profile(c.title, category);
      const result = await env.DB.prepare(
        "INSERT OR IGNORE INTO soundtrack_recordings (id,source_title,source_page_url,source_file_url,source_sha1,source_size,mime,title,performer,license_code,license_url,license_statement,attribution_text,period,instruments_json,moods_json,energy,has_vocals,evidence_json,discovered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(c.id, page.title, c.sourcePage, c.mediaUrl, c.sha1,c.size,c.mime,c.title,
        c.performer,c.license.code,c.license.link,c.license.statement,c.attribution,
        category.period,JSON.stringify(tags.instruments),JSON.stringify(tags.moods),
        tags.energy,tags.hasVocals,JSON.stringify({ source:"commons_imageinfo",filePage:c.sourcePage,
          claimedLicense:c.license.statement,claimedLicenseUrl:c.license.link,
          rawLicenseUrl:c.info.extmetadata?.LicenseUrl?.value || "",
          sourceSha1:c.sha1,sourceSize:c.size,artist:c.performer,
          sourceMime:c.info.mime,sourceUrl:c.info.url,
          capturedAt:now,rightsNote:"UNVERIFIED: composition, arrangement and master recording require individual rights review" }),
        now,now).run() as { meta?: { changes?: number } };
      added += Number(result?.meta?.changes || 0);
    }
    const reachedLimit = Number(state.discovered) + added >= MAX_DISCOVERED;
    cursors[category.name] = data.continue?.gcmcontinue || "DONE";
    await env.DB.prepare(
      "UPDATE soundtrack_ingestion_state SET category_index=?,category_cursors_json=?,continuation='',discovered=discovered+?,last_discovery_at=?,last_error='',lease_until='',lease_token='' WHERE id=1 AND lease_token=?",
    ).bind((categoryIndex+1)%CATEGORIES.length,JSON.stringify(cursors),added,now,token).run();
    return { scanned: pages.length, queuedForRightsReview: added, total: Number(state.discovered)+added,
      reachedLimit, source: category.name };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE soundtrack_ingestion_state SET lease_until='',lease_token='',last_error=?,last_discovery_at=? WHERE id=1 AND lease_token=?",
    ).bind(String(error).slice(0,400),now,token).run();
    return { error: "Discovery temporarily unavailable" };
  }
}
async function commonsFile(title: string) {
  const p = new URLSearchParams({ titles: title, prop: "imageinfo|revisions",
    rvprop: "ids|timestamp|content", rvslots: "main", iiprop: "url|mime|size|sha1|extmetadata" });
  const data = await commonsRequest(p);
  return Object.values(data.query?.pages || {})[0] as CommonsPage | undefined;
}
function evidenceMatches(r: SoundtrackRow, info: CommonsInfo | undefined) {
  const current = info && licensed(info);
  return !!info && !!current && current.code === r.license_code &&
    current.link === r.license_url && current.statement === r.license_statement &&
    Number(info.size) === r.source_size &&
    String(info.sha1 || "").toLowerCase() === r.source_sha1 &&
    playableMime(info) === r.mime && sourceFileUrl(info) === r.source_file_url;
}
function territoryAllowed(record: SoundtrackRow, territory: string) {
  try {
    const list = JSON.parse(record.allowed_territories_json) as string[];
    return list.includes(territory) || list.includes("*");
  } catch { return false; }
}
export async function importOneReviewedSoundtrack(env: CoveEnv) {
  if (!env.BUCKET) return { skipped: "no_storage" };
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const lease = await env.DB.prepare(
    "UPDATE soundtrack_ingestion_state SET lease_token=?,lease_until=? WHERE id=1 AND lease_until<? RETURNING id",
  ).bind(token,new Date(Date.now()+120_000).toISOString(),now).first<{ id:number }>();
  if (!lease) return { skipped: "leased" };
  try {
    const cleanup = await env.DB.prepare("SELECT storage_key FROM soundtrack_cleanup_queue ORDER BY created_at LIMIT 1")
      .first<{storage_key:string}>();
    if (cleanup) {
      await env.BUCKET.delete(cleanup.storage_key);
      await env.DB.prepare("DELETE FROM soundtrack_cleanup_queue WHERE storage_key=?").bind(cleanup.storage_key).run();
    }
    // A terminated invocation may leave a claim behind. Never retry a revoked file.
    await env.DB.prepare("UPDATE soundtrack_recordings SET status='approved',updated_at=? WHERE status='importing' AND updated_at<?")
      .bind(now,new Date(Date.now()-10*60_000).toISOString()).run();
    const track = await env.DB.prepare(
      "UPDATE soundtrack_recordings SET status='importing',updated_at=? WHERE id=(SELECT id FROM soundtrack_recordings WHERE status='approved' AND quality_status='passed' AND source_snapshot_key IS NOT NULL ORDER BY reviewed_at LIMIT 1) AND status='approved' RETURNING *",
    ).bind(now).first<SoundtrackRow>();
    if (!track) return { skipped: "no_approved_recordings" };
    try {
      const report = soundtrackQualitySchema.parse(JSON.parse(track.quality_report_json));
      if (!qualityPasses(report) || report.sourceSha1 !== track.source_sha1 || report.bytes !== track.source_size)
        throw new Error("Audio QA does not match the approved source");
      const page = await commonsFile(track.source_title);
      if (!evidenceMatches(track,page?.imageinfo?.[0])) {
        await env.DB.prepare(
          "UPDATE soundtrack_recordings SET status='pending_review',reviewed_at=NULL,reviewed_by=NULL,review_evidence=NULL,allowed_territories_json='[]',updated_at=? WHERE id=? AND status='importing' AND updated_at=?",
        ).bind(now,track.id,now).run();
        return { invalidated: track.id, reason: "Source or rights metadata changed" };
      }
      const snapshot = await env.BUCKET.get(track.source_snapshot_key!);
      if (!snapshot?.body) throw new Error("Archived source evidence is missing");
      const archived = JSON.parse(await new Response(snapshot.body).text()) as { revisionId?: number };
      if (!archived.revisionId || archived.revisionId !== page?.revisions?.[0]?.revid)
        throw new Error("Source revision changed; a fresh review is required");
      const upstream = await fetch(track.source_file_url, {
        headers: { "User-Agent": AGENT }, redirect: "manual",
        signal: AbortSignal.timeout(90_000),
      });
      const contentLength = upstream.headers.get("content-length");
      const contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const mimeCompatible = contentType === track.mime ||
        (track.mime === "audio/ogg" && contentType === "application/ogg");
      if (!upstream.ok || !upstream.body || (contentLength && Number(contentLength) !== track.source_size) ||
          !mimeCompatible) throw new Error("Source media size or type changed");
      const key = "soundtracks/v1/" + track.id + "/" + token + (track.mime === "audio/mpeg" ? ".mp3" : ".ogg");
      // R2 validates the checksum while receiving the stream; do not buffer music in Worker memory.
      await env.BUCKET.put(key,upstream.body,{ sha256: report.sha256,
        httpMetadata:{ contentType: track.mime }, customMetadata:{ source:"wikimedia_commons",id:track.id } });
      const head = await env.BUCKET.head?.(key);
      if (!head || head.size !== track.source_size) {
        await env.BUCKET.delete(key);
        throw new Error("Stored file size check failed");
      }
      const result = await env.DB.prepare(
        "UPDATE soundtrack_recordings SET status='ready',last_import_error='',storage_key=?,storage_sha1=?,storage_bytes=?,stored_at=?,updated_at=? WHERE id=? AND status='importing' AND reviewed_at=? AND updated_at=? RETURNING id",
      ).bind(key,track.source_sha1,head.size,now,now,track.id,track.reviewed_at,now).first();
      if (!result) {
        await env.BUCKET.delete(key);
        return { canceled: track.id };
      }
      await env.DB.prepare("UPDATE soundtrack_ingestion_state SET downloaded=downloaded+1,last_import_at=? WHERE id=1")
        .bind(now).run();
      return { stored: track.id };
    } catch (error) {
      await env.DB.prepare(
        "UPDATE soundtrack_recordings SET status='import_failed',last_import_error=?,updated_at=? WHERE id=? AND status='importing' AND updated_at=?",
      ).bind(String(error).slice(0,500),now,track.id,now).run();
      return { failed: track.id, reason: String(error).slice(0,180) };
    }
  } finally {
    await env.DB.prepare(
      "UPDATE soundtrack_ingestion_state SET lease_until='',lease_token='' WHERE id=1 AND lease_token=?",
    ).bind(token).run();
  }
}
function publicRecord(r: SoundtrackRow) {
  return { id:r.id,title:r.title,performer:r.performer,composer:r.composer,
    period:r.period,instruments:JSON.parse(r.instruments_json),moods:JSON.parse(r.moods_json),
    energy:r.energy,hasVocals:r.has_vocals === null ? null : !!r.has_vocals,
    attribution:r.attribution_text,sourcePage:r.source_page_url,
    license:r.license_statement,licenseUrl:r.license_url,territories:JSON.parse(r.allowed_territories_json),
    modifications: JSON.parse(r.dossier_json || "{}").modificationNotice || "Original file; no modifications.",
    durationSeconds: JSON.parse(r.quality_report_json || "{}").durationSeconds,
    audioUrl:"/api/fore/soundtracks/recordings/"+r.id+"/audio" };
}
export async function handleSoundtracks(request: Request,env:CoveEnv,path:string,territory:string, staffIdentity: CoveIdentity | null = null): Promise<Response | null> {
  if (!path.startsWith("/soundtracks") && !path.startsWith("/admin/soundtracks")) return null;
  const admin = path.startsWith("/admin/");
  let principalId = "";
  if (admin) {
    if (staffIdentity) {
      const staff = await requireStaffPermission(env.DB,staffIdentity,"soundtracks.review",request);
      principalId = "staff:" + staff.userId;
    } else {
      const principal = await requireServiceScope(env.DB,request,"soundtracks.review");
      principalId = "service:" + principal.principalId;
    }
  }
  const url = new URL(request.url);
  const idMatch = /^\/(?:admin\/)?soundtracks\/recordings\/(cm_[0-9]{1,15})(?:\/audio)?$/.exec(path);
  if (!admin && path === "/soundtracks/recordings" && request.method === "GET") {
    const rows = (await env.DB.prepare(
      "SELECT * FROM soundtrack_recordings WHERE status='ready' AND quality_status='passed' AND source_snapshot_key IS NOT NULL ORDER BY title,id LIMIT 300",
    ).all<SoundtrackRow>()).results.filter(r=>territoryAllowed(r,territory));
    return json({ recordings: rows.map(publicRecord),count:rows.length });
  }
  if (admin && path === "/admin/soundtracks" && request.method === "GET") {
    const counts = (await env.DB.prepare(
      "SELECT status,quality_status,COUNT(*) count FROM soundtrack_recordings GROUP BY status,quality_status",
    ).all<{ status:string; quality_status:string; count:number }>()).results;
    const limit = Math.min(100,Math.max(1,Number(url.searchParams.get("limit")) || 40));
    const after = url.searchParams.get("after") || "";
    const rows = (await env.DB.prepare(
      "SELECT * FROM soundtrack_recordings WHERE status=? AND id>? ORDER BY id LIMIT ?",
    ).bind(url.searchParams.get("status") || "pending_review",after,limit+1).all<SoundtrackRow>()).results;
    return json({ counts,records:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null });
  }
  if (admin && idMatch && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM soundtrack_recordings WHERE id=?")
      .bind(idMatch[1]).first<SoundtrackRow>();
    if (!row) throw new ApiError(404,"Recording not found.");
    const history = (await env.DB.prepare(
      "SELECT * FROM soundtrack_review_events WHERE recording_id=? ORDER BY created_at DESC,id DESC LIMIT 100",
    ).bind(row.id).all()).results;
    return json({record:row,history});
  }
  if (admin && idMatch && request.method === "POST") {
    const input = await readBody(request,60000) as Record<string,unknown>;
    const action = String(input.action || "");
    if (!["draft","endorse","quality","approve","reject","revoke","retry"].includes(action))
      throw new ApiError(400,"Invalid review decision.");
    const original = await env.DB.prepare("SELECT * FROM soundtrack_recordings WHERE id=?")
      .bind(idMatch[1]).first<SoundtrackRow>();
    if (!original) throw new ApiError(404,"Recording not found.");
    if (input.version !== original.review_version)
      throw new ApiError(409,"The review changed. Refresh before submitting this decision.");
    const at = new Date().toISOString();
    const version = original.review_version + 1;
    const eventId = crypto.randomUUID();
    const event = (payload:unknown) => env.DB.prepare(
      "INSERT INTO soundtrack_review_events(id,recording_id,principal_id,event_type,source_sha1,payload_json,created_at) SELECT ?,id,?,?,?,?,? FROM soundtrack_recordings WHERE id=? AND review_version=? AND changes()=1",
    ).bind(eventId,principalId,action,original.source_sha1,JSON.stringify(payload),at,original.id,version);
    // The versioned update and its audit event commit together or both roll back.
    const commit = async (update:ReturnType<CoveEnv["DB"]["prepare"]>,payload:unknown,decision=false) => {
      const statements = [update,event(payload)];
      if (["revoke","reject"].includes(action) && original.storage_key) statements.push(env.DB.prepare(
        "INSERT OR IGNORE INTO soundtrack_cleanup_queue(storage_key,recording_id,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM soundtrack_review_events WHERE id=?)",
      ).bind(original.storage_key,original.id,at,eventId));
      if (decision) statements.push(env.DB.prepare(
        "INSERT INTO soundtrack_rights_decisions(id,recording_id,principal_id,action,evidence_json,decided_at) SELECT ?,id,?,?,?,? FROM soundtrack_recordings WHERE id=? AND review_version=? AND EXISTS(SELECT 1 FROM soundtrack_review_events WHERE id=?)",
      ).bind(eventId,principalId,action,JSON.stringify(payload),at,original.id,version,eventId));
      await env.DB.batch(statements);
      const committed = await env.DB.prepare("SELECT id FROM soundtrack_review_events WHERE id=?").bind(eventId).first();
      if (!committed) throw new ApiError(409,"A concurrent review won. Refresh before trying again.");
      return json({recordingId:original.id,action,version});
    };
    if (action === "quality") {
      if (["ready","importing","revoked"].includes(original.status))
        throw new ApiError(409,"Withdraw or finish the current release before replacing audio QA.");
      const parsed = soundtrackQualitySchema.safeParse(input.report);
      if (!parsed.success) throw new ApiError(422,"Complete measured audio QA is required.");
      const report = parsed.data;
      if (report.sourceSha1 !== original.source_sha1 || report.bytes !== original.source_size)
        throw new ApiError(409,"Audio QA describes a different source file.");
      const status = qualityPasses(report)?"passed":"failed";
      return commit(env.DB.prepare(
        "UPDATE soundtrack_recordings SET quality_report_json=?,quality_status=?,review_version=?,updated_at=? WHERE id=? AND review_version=?",
      ).bind(JSON.stringify(report),status,version,at,original.id,original.review_version),{report,status});
    }
    if (action === "draft") {
      if (!["pending_review","import_failed","rejected"].includes(original.status))
        throw new ApiError(409,"Withdraw the released recording before editing its rights dossier.");
      const parsed = soundtrackDossierSchema.safeParse(input.dossier);
      if (!parsed.success) throw new ApiError(422,"Each rights layer requires a rationale and source links.");
      return commit(env.DB.prepare(
        "UPDATE soundtrack_recordings SET dossier_json=?,review_version=?,updated_at=? WHERE id=? AND review_version=?",
      ).bind(JSON.stringify(parsed.data),version,at,original.id,original.review_version),{dossier:parsed.data});
    }
    if (action === "endorse") {
      const reason = clearText(input.reason,2500);
      if (reason.length<80) throw new ApiError(422,"An independent second-review rationale is required.");
      const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(original.dossier_json));
      const dossierSha256 = Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
      return commit(env.DB.prepare(
        "UPDATE soundtrack_recordings SET review_version=?,updated_at=? WHERE id=? AND review_version=?",
      ).bind(version,at,original.id,original.review_version),{reason,dossierSha256});
    }
    if (action === "approve") {
      if (!["pending_review","import_failed","rejected"].includes(original.status))
        throw new ApiError(409,"The recording is not awaiting review.");
      const parsed = soundtrackDossierSchema.safeParse(JSON.parse(original.dossier_json));
      if (!parsed.success || parsed.data.unresolved.length)
        throw new ApiError(422,"A complete dossier with no unresolved rights questions is required.");
      const dossier = parsed.data;
      if (original.quality_status!=="passed") throw new ApiError(422,"Measured audio QA must pass before approval.");
      if (original.license_code === "PD" || dossier.complexProvenance) {
        const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(original.dossier_json));
        const dossierSha256 = Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
        const second = await env.DB.prepare(
          "SELECT id FROM soundtrack_review_events WHERE recording_id=? AND source_sha1=? AND event_type='endorse' AND principal_id!=? AND json_extract(payload_json,'$.dossierSha256')=? LIMIT 1",
        ).bind(original.id,original.source_sha1,principalId,dossierSha256).first();
        if (!second) throw new ApiError(422,"This provenance requires a second independent reviewer of the current dossier.");
      }
      const duplicate = await env.DB.prepare(
        "SELECT id FROM soundtrack_recordings WHERE source_sha1=? AND id!=? AND status IN ('approved','importing','ready') LIMIT 1",
      ).bind(original.source_sha1,original.id).first();
      if (duplicate) throw new ApiError(409,"This exact recording is already approved under another source identity.");
      const reviewer = clearText(input.reviewer,120);
      const rationale = clearText(input.reviewEvidence,2500);
      const performer = clearText(input.performer,400);
      const composer = clearText(input.composer,300);
      const territories = input.territories;
      const validTerritories = Array.isArray(territories) && territories.length>0 && territories.length<=250 &&
        territories.every(v=>typeof v==="string" && (v==="*" || /^[A-Z]{2}$/.test(v)));
      const inst = input.instruments, moods = input.moods, energy = input.energy, vocals = input.hasVocals;
      if (!reviewer || rationale.length<80 || !performer || /unverified|unknown/i.test(performer) || !composer ||
          !validTerritories || input.compositionRightsConfirmed!==true || input.performanceRightsConfirmed!==true ||
          input.attributionReviewed!==true || !Array.isArray(inst) || !Array.isArray(moods) ||
          inst.length<1 || inst.length>20 || moods.length<1 || moods.length>20 ||
          !inst.every(v=>typeof v==="string" && v.trim().length>=2 && v.length<=40) ||
          !moods.every(v=>typeof v==="string" && v.trim().length>=2 && v.length<=40) ||
          typeof energy!=="number" || !Number.isFinite(energy) || energy<0 || energy>1 || typeof vocals!=="boolean" ||
          !["medieval","renaissance","baroque","classical","romantic","modern","contemporary"].includes(String(input.period)))
        throw new ApiError(422,"Individual rights review, territories, attribution, and complete musical tags are required.");
      const current = await commonsFile(original.source_title);
      if (!evidenceMatches(original,current?.imageinfo?.[0]) || !current?.revisions?.[0]?.revid)
        throw new ApiError(409,"Commons source or license changed since discovery, or no source revision is available.");
      if (!env.BUCKET) throw new ApiError(503,"Evidence storage unavailable.");
      const revisionId = current.revisions[0].revid;
      const snapshot = JSON.stringify({recordingId:original.id,capturedAt:at,revisionId,page:current,
        permanentUrl:"https://commons.wikimedia.org/w/index.php?oldid="+revisionId});
      if (snapshot.length>500000) throw new ApiError(422,"Source evidence exceeds the review snapshot limit.");
      const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(snapshot));
      const snapshotSha256 = Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
      const key = "soundtracks/evidence/"+original.id+"/"+snapshotSha256+".json";
      await env.BUCKET.put(key,new TextEncoder().encode(snapshot),{sha256:snapshotSha256,httpMetadata:{contentType:"application/json"}});
      return commit(env.DB.prepare(
        "UPDATE soundtrack_recordings SET status='approved',reviewed_at=?,reviewed_by=?,review_evidence=?,performer=?,composer=?,period=?,instruments_json=?,moods_json=?,energy=?,has_vocals=?,tag_source='reviewed',attribution_text=?,allowed_territories_json=?,source_snapshot_key=?,review_version=?,updated_at=? WHERE id=? AND review_version=?",
      ).bind(at,principalId+":"+reviewer,rationale,performer,composer,String(input.period),JSON.stringify(inst),JSON.stringify(moods),
        energy,vocals?1:0,dossier.attributionText,JSON.stringify([...new Set(territories as string[])]),key,version,at,original.id,original.review_version),
        {reviewerTicket:reviewer,reviewEvidence:rationale,dossier,composer,performer,territories,
          sourceSha1:original.source_sha1,license:original.license_statement,licenseUrl:original.license_url,
          sourcePage:original.source_page_url,revisionId,snapshotSha256,snapshotKey:key},true);
    }
    if (action === "retry") {
      if (original.status!=="import_failed" || !original.reviewed_at || !original.source_snapshot_key || original.quality_status!=="passed")
        throw new ApiError(409,"Only reviewed, QA-passed failed imports can be retried.");
      return commit(env.DB.prepare(
        "UPDATE soundtrack_recordings SET status='approved',last_import_error='',review_version=?,updated_at=? WHERE id=? AND review_version=?",
      ).bind(version,at,original.id,original.review_version),{priorReviewAt:original.reviewed_at,sourceSha1:original.source_sha1},true);
    }
    const reason = clearText(input.reason,2500);
    if (reason.length<20) throw new ApiError(422,"A withdrawal or rejection reason is required.");
    // Withdraw the entitlement and commit its audit record before attempting object cleanup.
    const result = await commit(env.DB.prepare(
      "UPDATE soundtrack_recordings SET status=?,storage_key=NULL,stored_at=NULL,storage_sha1=NULL,storage_bytes=NULL,allowed_territories_json='[]',review_version=?,updated_at=? WHERE id=? AND review_version=?",
    ).bind(action==="revoke"?"revoked":"rejected",version,at,original.id,original.review_version),
      {reason,sourceSha1:original.source_sha1,priorStatus:original.status,cleanupKey:original.storage_key},true);
    if (original.storage_key && env.BUCKET) {
      try { await env.BUCKET.delete(original.storage_key); }
      catch (error) { console.warn("Soundtrack withdrawn; R2 cleanup pending",original.id,String(error).slice(0,160)); }
    }
    return result;
  }
  if (!admin && idMatch && path.endsWith("/audio") && ["GET","HEAD"].includes(request.method)) {
    const row = await env.DB.prepare(
      "SELECT * FROM soundtrack_recordings WHERE id=? AND status='ready' AND quality_status='passed' AND source_snapshot_key IS NOT NULL",
    ).bind(idMatch[1]).first<SoundtrackRow>();
    if (!row || !territoryAllowed(row,territory) || !row.storage_key || !env.BUCKET)
      throw new ApiError(404,"Soundtrack recording is unavailable.");
    const head = await env.BUCKET.head?.(row.storage_key);
    if (!head || !row.storage_bytes || head.size !== row.storage_bytes)
      throw new ApiError(503,"Verified audio file is temporarily unavailable.");
    const range = request.headers.get("range");
    let offset=0,length=head.size,status=200;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) throw new ApiError(416,"Invalid audio range.");
      offset=Number(m[1]);
      const last=m[2] ? Number(m[2]):head.size-1;
      if (!Number.isSafeInteger(offset)||!Number.isSafeInteger(last)||offset<0||offset>=head.size||
          last<offset||last>=head.size) throw new ApiError(416,"Invalid audio range.");
      length=last-offset+1;status=206;
    }
    const headers = new Headers({ "Content-Type":row.mime,"Cache-Control":"private, no-store",
      "Accept-Ranges":"bytes","Content-Length":String(length),
      "X-Content-Type-Options":"nosniff" });
    if (status===206) headers.set("Content-Range","bytes "+offset+"-"+(offset+length-1)+"/"+head.size);
    if (request.method==="HEAD") return new Response(null,{status,headers});
    const object = await env.BUCKET.get(row.storage_key,status===206?{range:{offset,length}}:undefined);
    if (!object?.body) throw new ApiError(503,"Soundtrack recording is temporarily unavailable.");
    return new Response(object.body,{status,headers});
  }
  return null;
}
