/* eslint-disable prettier/prettier -- Module will be normalized when the soundtrack review UI stabilizes. */
import type { CoveEnv } from "./api.server";
import { ApiError, json, readBody } from "./service";
import { requireServiceScope } from "./privileged-access.server";

/** Rights-reviewed recording library. This is intentionally independent of audiobooks.
 * Discovery only queues candidates. Only an attested human review may authorize
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
const MAX_DISCOVERED = 250;
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
type CommonsPage = { pageid?: number; title?: string; imageinfo?: CommonsInfo[] };
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
  storage_bytes: number | null; evidence_json: string;
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
    headers: { "Api-User-Agent": AGENT, "Accept": "application/json" },
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
  const state = await env.DB.prepare("SELECT * FROM soundtrack_ingestion_state WHERE id=1").first<{ category_index:number; continuation:string; discovered:number; last_discovery_at:string }>();
  if (!state || state.discovered >= MAX_DISCOVERED || state.category_index >= CATEGORIES.length)
    return { skipped: "complete", discovered: Number(state?.discovered || 0) };
  const now = new Date().toISOString();
  if (state.last_discovery_at && Date.now() - Date.parse(state.last_discovery_at) < 50 * 60_000)
    return { skipped: "cadence" };
  const token = crypto.randomUUID();
  const lease = await env.DB.prepare(
    "UPDATE soundtrack_ingestion_state SET lease_token=?,lease_until=? WHERE id=1 AND lease_until<? RETURNING id",
  ).bind(token, new Date(Date.now()+90_000).toISOString(), now).first<{ id:number }>();
  if (!lease) return { skipped: "leased" };
  try {
    const category = CATEGORIES[Number(state.category_index)];
    const params = new URLSearchParams({
      generator: "categorymembers", gcmtitle: "Category:" + category.name,
      gcmtype: "file", gcmlimit: "100", prop: "imageinfo",
      iiprop: "url|mime|size|sha1|extmetadata",
    });
    if (state.continuation) params.set("gcmcontinue", state.continuation);
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
      ).bind(c.id, page.title, c.sourcePage, c.info.url, c.sha1,c.size,c.info.mime,c.title,
        c.performer,c.license.code,c.license.link,c.license.statement,c.attribution,
        category.period,JSON.stringify(tags.instruments),JSON.stringify(tags.moods),
        tags.energy,tags.hasVocals,JSON.stringify({ source:"commons_imageinfo",filePage:c.sourcePage,
          claimedLicense:c.license.statement,claimedLicenseUrl:c.license.link,
          sourceSha1:c.sha1,sourceSize:c.size,artist:c.performer,
          capturedAt:now,rightsNote:"UNVERIFIED: composition and performance need individual review" }),
        now,now).run() as { meta?: { changes?: number } };
      added += Number(result?.meta?.changes || 0);
    }
    const reachedLimit = Number(state.discovered) + added >= MAX_DISCOVERED;
    await env.DB.prepare(
      "UPDATE soundtrack_ingestion_state SET category_index=?,continuation=?,discovered=discovered+?,last_discovery_at=?,last_error='',lease_until='',lease_token='' WHERE id=1 AND lease_token=?",
    ).bind(reachedLimit ? CATEGORIES.length : (data.continue?.gcmcontinue ? state.category_index : Number(state.category_index)+1),
      reachedLimit ? "" : (data.continue?.gcmcontinue || ""),added,now,token).run();
    return { scanned: pages.length, queuedForRightsReview: added, total: Number(state.discovered)+added,
      source: category.name };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE soundtrack_ingestion_state SET lease_until='',lease_token='',last_error=?,last_discovery_at=? WHERE id=1 AND lease_token=?",
    ).bind(String(error).slice(0,400),now,token).run();
    return { error: "Discovery temporarily unavailable" };
  }
}
async function commonsFile(title: string) {
  const p = new URLSearchParams({ titles: title, prop: "imageinfo",
    iiprop: "url|mime|size|sha1|extmetadata" });
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
    const track = await env.DB.prepare(
      "UPDATE soundtrack_recordings SET status='importing',updated_at=? WHERE id=(SELECT id FROM soundtrack_recordings WHERE status='approved' ORDER BY reviewed_at LIMIT 1) AND status='approved' RETURNING *",
    ).bind(now).first<SoundtrackRow>();
    if (!track) return { skipped: "no_approved_recordings" };
    try {
      const page = await commonsFile(track.source_title);
      if (!evidenceMatches(track,page?.imageinfo?.[0])) {
        await env.DB.prepare(
          "UPDATE soundtrack_recordings SET status='pending_review',reviewed_at=NULL,reviewed_by=NULL,review_evidence=NULL,allowed_territories_json='[]',updated_at=? WHERE id=? AND status='importing'",
        ).bind(now,track.id).run();
        return { invalidated: track.id, reason: "Source or rights metadata changed" };
      }
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
      const key = "soundtracks/v1/" + track.id + (track.mime === "audio/mpeg" ? ".mp3" : ".ogg");
      // R2 validates the checksum while receiving the stream; do not buffer music in Worker memory.
      await env.BUCKET.put(key,upstream.body,{ sha1: track.source_sha1,
        httpMetadata:{ contentType: track.mime }, customMetadata:{ source:"wikimedia_commons",id:track.id } });
      const head = await env.BUCKET.head?.(key);
      if (!head || head.size !== track.source_size) {
        await env.BUCKET.delete(key);
        throw new Error("Stored file size check failed");
      }
      const result = await env.DB.prepare(
        "UPDATE soundtrack_recordings SET status='ready',storage_key=?,storage_sha1=?,storage_bytes=?,stored_at=?,updated_at=? WHERE id=? AND status='importing' AND reviewed_at=? RETURNING id",
      ).bind(key,track.source_sha1,head.size,now,now,track.id,track.reviewed_at).first();
      if (!result) {
        await env.BUCKET.delete(key);
        return { canceled: track.id };
      }
      await env.DB.prepare("UPDATE soundtrack_ingestion_state SET downloaded=downloaded+1,last_import_at=? WHERE id=1")
        .bind(now).run();
      return { stored: track.id };
    } catch (error) {
      await env.DB.prepare(
        "UPDATE soundtrack_recordings SET status='import_failed',updated_at=? WHERE id=? AND status='importing'",
      ).bind(now,track.id).run();
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
    audioUrl:"/api/fore/soundtracks/recordings/"+r.id+"/audio" };
}
export async function handleSoundtracks(request: Request,env:CoveEnv,path:string,territory:string): Promise<Response | null> {
  if (!path.startsWith("/soundtracks") && !path.startsWith("/admin/soundtracks")) return null;
  const admin = path.startsWith("/admin/");
  const reviewerPrincipal = admin
    ? await requireServiceScope(env.DB,request,"audio.ingest")
    : null;
  const url = new URL(request.url);
  const idMatch = /^\/(?:admin\/)?soundtracks\/recordings\/(cm_[0-9]{1,15})(?:\/audio)?$/.exec(path);
  if (!admin && path === "/soundtracks/recordings" && request.method === "GET") {
    const rows = (await env.DB.prepare(
      "SELECT * FROM soundtrack_recordings WHERE status='ready' ORDER BY title,id LIMIT 300",
    ).all<SoundtrackRow>()).results.filter(r=>territoryAllowed(r,territory));
    return json({ recordings: rows.map(publicRecord),count:rows.length });
  }
  if (admin && path === "/admin/soundtracks" && request.method === "GET") {
    const counts = (await env.DB.prepare(
      "SELECT status,COUNT(*) count FROM soundtrack_recordings GROUP BY status",
    ).all<{ status:string; count:number }>()).results;
    const limit = Math.min(100,Math.max(1,Number(url.searchParams.get("limit")) || 40));
    const rows = (await env.DB.prepare(
      "SELECT * FROM soundtrack_recordings WHERE status=? ORDER BY discovered_at,id LIMIT ?",
    ).bind(url.searchParams.get("status") || "pending_review",limit).all<SoundtrackRow>()).results;
    return json({ counts,records:rows });
  }
  if (admin && idMatch && request.method === "POST" && path.startsWith("/admin/")) {
    const input = await readBody(request,30000) as Record<string,unknown>;
    const action = String(input.action || "");
    if (!["approve","reject","revoke","retry"].includes(action))
      throw new ApiError(400,"Invalid review decision.");
    const original = await env.DB.prepare(
      "SELECT * FROM soundtrack_recordings WHERE id=?",
    ).bind(idMatch[1]).first<SoundtrackRow>();
    if (!original) throw new ApiError(404,"Recording not found.");
    if (action === "approve") {
      if (!["pending_review","import_failed","rejected"].includes(original.status))
        throw new ApiError(409,"The recording is not awaiting review.");
      const reviewer = clearText(input.reviewer,120);
      const rationale = clearText(input.reviewEvidence,2500);
      const performer = clearText(input.performer ?? original.performer,400);
      const composer = clearText(input.composer ?? original.composer,300);
      const territories = input.territories;
      const validTerritories = Array.isArray(territories) && territories.length>0 && territories.length<=250 &&
        territories.every(v=>typeof v==="string" && (v==="*" || /^[A-Z]{2}$/.test(v)));
      const inst = input.instruments;
      const moods = input.moods;
      const energy = input.energy;
      const vocals = input.hasVocals;
      if (!reviewer || rationale.length<80 || !performer || /unverified|unknown/i.test(performer) ||
          !composer || !validTerritories || input.compositionRightsConfirmed !== true ||
          input.performanceRightsConfirmed !== true || input.attributionReviewed !== true ||
          !Array.isArray(inst) || !Array.isArray(moods) || inst.length<1 || moods.length<1 ||
          !inst.every(v=>typeof v==="string" && v.length>=2 && v.length<=40) ||
          !moods.every(v=>typeof v==="string" && v.length>=2 && v.length<=40) ||
          typeof energy!=="number" || energy<0 || energy>1 || typeof vocals!=="boolean")
        throw new ApiError(422,"Individual composition/performance review, territories, attribution, and complete musical tags are required.");
      // Recheck the upstream file's live evidence before human approval as well as before import.
      const current = await commonsFile(original.source_title);
      if (!evidenceMatches(original,current?.imageinfo?.[0]))
        throw new ApiError(409,"Commons source or license changed since discovery. Re-discover this recording.");
      const now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE soundtrack_recordings SET status='approved',reviewed_at=?,reviewed_by=?,review_evidence=?,performer=?,composer=?,period=?,instruments_json=?,moods_json=?,energy=?,has_vocals=?,tag_source='reviewed',attribution_text=?,allowed_territories_json=?,updated_at=? WHERE id=? AND status IN ('pending_review','import_failed','rejected')",
      ).bind(now,(reviewerPrincipal?.principalId || "unknown") + ":" + reviewer,rationale,performer,composer,clearText(input.period??original.period,60),
        JSON.stringify(inst),JSON.stringify(moods),energy,vocals?1:0,
        original.title+" — "+performer+" · "+original.license_statement,
        JSON.stringify(territories),now,original.id).run();
      return json({ approved:original.id,queuedForImport:true });
    }
    if (action === "retry" && original.status !== "import_failed")
      throw new ApiError(409,"Only failed imports can be retried.");
    if (action === "retry") {
      await env.DB.prepare(
        "UPDATE soundtrack_recordings SET status='approved',updated_at=? WHERE id=? AND status='import_failed' AND reviewed_at IS NOT NULL",
      ).bind(new Date().toISOString(),original.id).run();
      return json({ retried:original.id });
    }
    if (original.storage_key && env.BUCKET) await env.BUCKET.delete(original.storage_key);
    await env.DB.prepare(
      "UPDATE soundtrack_recordings SET status=?,storage_key=NULL,stored_at=NULL,storage_sha1=NULL,storage_bytes=NULL,allowed_territories_json='[]',updated_at=? WHERE id=?",
    ).bind(action==="revoke"?"revoked":"rejected",new Date().toISOString(),original.id).run();
    return json({ [action]:original.id });
  }
  if (!admin && idMatch && path.endsWith("/audio") && ["GET","HEAD"].includes(request.method)) {
    const row = await env.DB.prepare(
      "SELECT * FROM soundtrack_recordings WHERE id=? AND status='ready'",
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
    const headers = new Headers({ "Content-Type":row.mime,"Cache-Control":"private, max-age=60",
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
