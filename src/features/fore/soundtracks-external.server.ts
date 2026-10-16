/* eslint-disable prettier/prettier -- Evidence and R2 trust checks are kept adjacent for auditability. */
import { z } from "zod";
import type { CoveEnv } from "./api.server";
import type { CoveIdentity } from "./auth.server";
import { ApiError, json, readBody } from "./service";
import { soundtrackQualitySchema, qualityPasses } from "./soundtrack-review";

// Provider supply is by authorized delivery, never an automated download from
// FMA/Musopen's websites. Each master must pass evidence, QA, R2 and staff gates.
const evidenceUrl = z.string().url().max(1000).refine(value => {
  const u = new URL(value);
  return u.protocol === "https:" && !u.username && !u.password && !u.port;
}, "HTTPS evidence required");
const layer = z.object({ basis:z.string().trim().min(40).max(4000), evidenceUrls:z.array(evidenceUrl).min(1).max(12) });
// A record-specific CC license can authorize commercial reuse without a new contract.
// Site access is a separate gate: FMA manual, non-automated acquisition is attested.
const manualAcquisition = z.object({
  method: z.literal("manual_download"),
  sourcePageUrl: evidenceUrl,
  acquiredAt: z.string().datetime(),
  noAutomatedProviderAccess: z.literal(true),
  originalUnmodified: z.literal(true),
});
const providerGrant = z.object({
  grantingParty:z.string().trim().min(3).max(300),
  scope:z.string().trim().min(40).max(1500).refine(x=>/commercial/i.test(x) && /download/i.test(x) && /redistribut/i.test(x),
    "Grant must explicitly cover commercial downloading and redistribution"),
  evidenceUrl,
});
const rights = z.object({
  composition:layer, arrangement:layer, lyrics:layer, performance:layer, master:layer,
});
const manifestSchema = z.object({
  provider:z.enum(["fma","musopen"]),
  sourcePageUrl:evidenceUrl,
  title:z.string().trim().min(3).max(250),
  composer:z.string().trim().min(3).max(300),
  performer:z.string().trim().min(3).max(400),
  attributionText:z.string().trim().min(10).max(3000),
  licenseCode:z.enum(["PD","CC0","CC-BY","CC-BY-SA"]),
  licenseUrl:evidenceUrl,
  licenseStatement:z.string().trim().min(3).max(250),
  providerAccessGrant:providerGrant.optional(),
  acquisitionEvidence:manualAcquisition.optional(),
  rightsEvidence:rights,
  compositionRightsConfirmed:z.literal(true),
  masterRedistributionConfirmed:z.literal(true),
  unresolved:z.array(z.string().trim().min(1).max(1000)).max(20).length(0),
  territories:z.tuple([z.literal("US")]),
  sha1:z.string().regex(/^[a-f0-9]{40}$/),
  sha256:z.string().regex(/^[a-f0-9]{64}$/),
  bytes:z.number().int().positive().max(25*1024*1024),
  mime:z.enum(["audio/ogg","audio/mpeg"]),
  period:z.enum(["medieval","renaissance","baroque","classical","romantic","modern","contemporary"]),
  instruments:z.array(z.string().trim().min(2).max(40)).min(1).max(20),
  moods:z.array(z.string().trim().min(2).max(40)).min(1).max(20),
  energy:z.number().min(0).max(1),
  hasVocals:z.boolean(),
  quality:soundtrackQualitySchema,
}).superRefine((m,ctx)=>{
  const u = new URL(m.sourcePageUrl);
  const hostname = m.provider === "fma" ? "freemusicarchive.org" : "musopen.org";
  if (u.hostname !== hostname || !u.pathname.startsWith("/music/"))
    ctx.addIssue({code:"custom",message:"Provider-specific individual recording page required",path:["sourcePageUrl"]});
  const license = new URL(m.licenseUrl);
  const canonical = license.origin + license.pathname;
  const code = m.licenseCode;
  const valid = code === "PD" ?
    (m.provider === "musopen" && canonical === "https://musopen.org/faq/") :
    code === "CC0" ? canonical === "https://creativecommons.org/publicdomain/zero/1.0/" :
    new RegExp("^https://creativecommons\\.org/licenses/"+(code === "CC-BY"?"by":"by-sa")+"/(?:2\\.0|2\\.5|3\\.0|4\\.0)/$").test(canonical);
  if (!valid || license.search || license.hash)
    ctx.addIssue({code:"custom",message:"Exact provider-declared commercial license URL required",path:["licenseUrl"]});
  // Musopen public-domain claims are not a commercial website-acquisition grant.
  if (!m.providerAccessGrant &&
      !(m.provider === "fma" && m.licenseCode !== "PD" && m.acquisitionEvidence &&
        m.acquisitionEvidence.sourcePageUrl === m.sourcePageUrl))
    ctx.addIssue({code:"custom",message:"A specific delivery grant or a lawful FMA manual-acquisition attestation is required",path:["acquisitionEvidence"]});
  if (m.acquisitionEvidence && m.acquisitionEvidence.sourcePageUrl !== m.sourcePageUrl)
    ctx.addIssue({code:"custom",message:"Acquisition evidence must match the exact track page",path:["acquisitionEvidence"]});
  if (m.quality.sourceSha1 !== m.sha1 || m.quality.sha256 !== m.sha256 || m.quality.bytes !== m.bytes ||
      !qualityPasses(m.quality))
    ctx.addIssue({code:"custom",message:"Full audio QA must pass for the exact supplied master",path:["quality"]});
});

export type ExternalRecord = {
 id:string; provider:string; source_page_url:string; source_file_sha1:string; source_file_sha256:string;
 source_size:number; mime:string; title:string; performer:string; composer:string; license_code:string;
 license_url:string; license_statement:string; attribution_text:string; period:string;
 instruments_json:string; moods_json:string; energy:number; has_vocals:number;
 territories_json:string; provenance_json:string; provenance_sha256:string; quality_report_json:string;
 status:string; storage_key:string|null; storage_bytes:number|null; reviewed_by:string|null; reviewed_at:string|null;
};
const timestamp = () => new Date().toISOString();
const hash = async (text:string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,"0")).join("");
function playbackAllowed(row:ExternalRecord, territory:string) {
  try { return JSON.parse(row.territories_json).includes(territory); } catch { return false; }
}
async function event(env:CoveEnv,id:string,actor:string,type:string,payload:unknown) {
  await env.DB.prepare("INSERT INTO soundtrack_external_events(id,recording_id,actor,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),id,actor,type,JSON.stringify(payload),timestamp()).run();
}
const lookup = (env:CoveEnv,id:string) =>
  env.DB.prepare("SELECT * FROM soundtrack_external_recordings WHERE id=?").bind(id).first<ExternalRecord>();
export function publicExternal(row:ExternalRecord) {
  const q = JSON.parse(row.quality_report_json);
  return {
    id:row.id,title:row.title,performer:row.performer,composer:row.composer,
    period:row.period,instruments:JSON.parse(row.instruments_json),moods:JSON.parse(row.moods_json),
    energy:row.energy,hasVocals:!!row.has_vocals,attribution:row.attribution_text,
    sourcePage:row.source_page_url,license:row.license_statement,licenseUrl:row.license_url,
    territories:JSON.parse(row.territories_json),modifications:"Original recording: no modifications.",
    durationSeconds:q.durationSeconds,profileUrl:"/api/fore/soundtracks/recordings/"+row.id+"/profile",audioUrl:"/api/fore/soundtracks/recordings/"+row.id+"/audio",
  };
}
export async function publicExternalList(env:CoveEnv,territory:string) {
  const rows = (await env.DB.prepare(
    "SELECT * FROM soundtrack_external_recordings WHERE status='ready' AND storage_key IS NOT NULL ORDER BY title,id LIMIT 300"
  ).all<ExternalRecord>()).results;
  return rows.filter(r=>playbackAllowed(r,territory)).map(publicExternal);
}
export async function handleExternalSoundtracks(
  request:Request,env:CoveEnv,path:string,territory:string,actor:string,staff:CoveIdentity|null,
):Promise<Response|null> {
  const isAdmin = path.startsWith("/admin/");
  const base = "/admin/soundtracks/external";
  const publicAudio = /^\/soundtracks\/recordings\/(ex_[0-9a-f-]{36})\/audio$/.exec(path);
  const staffPreview = isAdmin ? /^\/admin\/soundtracks\/external\/(ex_[0-9a-f-]{36})\/audio$/.exec(path) : null;
  const audio = publicAudio || staffPreview;
  // Provider service tokens may upload originals but must not preview unreleased ones.
  if (staffPreview && request.method !== "PUT" && (!staff || staff.aal !== "aal2"))
    throw new ApiError(403, "Staff MFA required for private audio preview.");
  if (audio && ["GET","HEAD"].includes(request.method)) {
    const row = await lookup(env,audio[1]);
    if (!row || !row.storage_key || !row.storage_bytes || !env.BUCKET ||
        (staffPreview ? !["staged","ready"].includes(row.status) :
          (row.status!=="ready" || !playbackAllowed(row,territory))))
      throw new ApiError(404,"External soundtrack is unavailable.");
    const head = await env.BUCKET.head?.(row.storage_key);
    if (!head || head.size !== row.source_size || head.size !== row.storage_bytes)
      throw new ApiError(503,"The verified master is unavailable.");
    const invalid = () => new Response(null,{status:416,headers:{"Content-Range":"bytes */"+head.size,
      "Accept-Ranges":"bytes","Cache-Control":"private, no-store"}});
    const range = request.method==="GET"?request.headers.get("range"):null;
    let offset=0,last=head.size-1,status=200;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (!m[1] && !m[2])) return invalid();
      if (!m[1]) {
        const suffix=Number(m[2]);
        if (!Number.isSafeInteger(suffix)||suffix<=0) return invalid();
        offset=Math.max(0,head.size-suffix);
      } else {
        offset=Number(m[1]);
        if (m[2]) last=Number(m[2]);
        if (!Number.isSafeInteger(offset)||!Number.isSafeInteger(last)||offset<0||offset>=head.size||last<offset)
          return invalid();
        last=Math.min(last,head.size-1);
      }
      status=206;
    }
    const length=last-offset+1;
    const headers = new Headers({"Content-Type":row.mime,"Content-Length":String(length),
      "Cache-Control":"private, no-store","Accept-Ranges":"bytes","X-Content-Type-Options":"nosniff"});
    if (status===206) headers.set("Content-Range", "bytes "+offset+"-"+last+"/"+head.size);
    if (request.method==="HEAD") return new Response(null,{status,headers});
    const stored = await env.BUCKET.get(row.storage_key,status===206?{range:{offset,length}}:undefined);
    if (!stored?.body) throw new ApiError(503,"Verified master temporarily unavailable.");
    return new Response(stored.body,{status,headers});
  }
  if (!isAdmin || !path.startsWith(base)) return null;
  if (path===base && request.method==="GET") {
    const counts=(await env.DB.prepare(
      "SELECT provider,status,COUNT(*) n FROM soundtrack_external_recordings GROUP BY provider,status"
    ).all()).results;
    const records=(await env.DB.prepare(
      "SELECT id,provider,source_page_url,title,status,reviewed_at,created_at FROM soundtrack_external_recordings ORDER BY created_at DESC LIMIT 100"
    ).all()).results;
    return json({counts,records});
  }
  if (path===base+"/register" && request.method==="POST") {
    const result=manifestSchema.safeParse(await readBody(request,28000));
    if (!result.success) throw new ApiError(422,"Exact-source QA and five-layer provider rights evidence required.");
    const m=result.data;
    const duplicate = await env.DB.prepare(
      "SELECT id FROM soundtrack_recordings WHERE source_sha1=? AND status IN ('approved','importing','ready') LIMIT 1"
    ).bind(m.sha1).first();
    if (duplicate) throw new ApiError(409,"The master is already approved in Commons.");
    const provenance = {
      provider:m.provider,sourcePageUrl:m.sourcePageUrl,licenseCode:m.licenseCode,licenseUrl:m.licenseUrl,
      grant:m.providerAccessGrant || null,acquisition:m.acquisitionEvidence || null,rightsEvidence:m.rightsEvidence,
      confirmed:{composition:m.compositionRightsConfirmed,master:m.masterRedistributionConfirmed},
      unresolved:m.unresolved,
      note:"Source license and access grants remain claims pending named human staff approval; no website scraping.",
    };
    const provenanceText=JSON.stringify(provenance);
    const digest=await hash(provenanceText);
    const prior = await env.DB.prepare(
      "SELECT id,status,source_page_url,source_file_sha256,provenance_sha256 FROM soundtrack_external_recordings WHERE source_page_url=? OR source_file_sha256=? LIMIT 1"
    ).bind(m.sourcePageUrl,m.sha256).first<{id:string;status:string;source_page_url:string;source_file_sha256:string;provenance_sha256:string}>();
    if (prior) {
      if (prior.source_page_url!==m.sourcePageUrl || prior.source_file_sha256!==m.sha256 ||
          prior.provenance_sha256!==digest || !["pending_review","staged"].includes(prior.status))
        throw new ApiError(409,"Registered master, source page or rights provenance conflicts with this submission.");
      return json({id:prior.id,status:prior.status,provenanceSha256:digest,reused:true});
    }
    const id="ex_"+crypto.randomUUID(), at=timestamp();
    try {
      await env.DB.prepare(
        "INSERT INTO soundtrack_external_recordings(id,provider,source_page_url,source_file_sha1,source_file_sha256,source_size,mime,title,performer,composer,license_code,license_url,license_statement,attribution_text,period,instruments_json,moods_json,energy,has_vocals,territories_json,provenance_json,provenance_sha256,quality_report_json,status,registered_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_review',?,?,?)"
      ).bind(id,m.provider,m.sourcePageUrl,m.sha1,m.sha256,m.bytes,m.mime,m.title,m.performer,m.composer,
        m.licenseCode,m.licenseUrl,m.licenseStatement,m.attributionText,m.period,JSON.stringify(m.instruments),
        JSON.stringify(m.moods),m.energy,m.hasVocals?1:0,JSON.stringify(m.territories),provenanceText,digest,
        JSON.stringify(m.quality),actor,at,at).run();
    } catch {
      throw new ApiError(409,"This source page or master has already been registered.");
    }
    await event(env,id,actor,"registered",{provider:m.provider,sha256:m.sha256,provenanceSha256:digest});
    return json({id,status:"pending_review",provenanceSha256:digest},201);
  }
  const match = /^\/admin\/soundtracks\/external\/(ex_[0-9a-f-]{36})(?:\/(audio|approve|revoke|reject))?$/.exec(path);
  if (!match) return null;
  const id=match[1], action=match[2];
  const row=await lookup(env,id);
  if (!row) throw new ApiError(404,"Unknown external recording");
  if (!action && request.method==="GET") {
    const history=(await env.DB.prepare("SELECT * FROM soundtrack_external_events WHERE recording_id=? ORDER BY created_at DESC LIMIT 100")
      .bind(id).all()).results;
    return json({record:row,history});
  }
  if (action==="audio" && request.method==="PUT") {
    if (!env.BUCKET) throw new ApiError(503,"Private object storage unavailable");
    if (row.status === "staged" && row.storage_key) {
      // Repeated delivery is idempotent, never a replacement of staff-reviewable audio.
      const stored = await env.BUCKET.head?.(row.storage_key);
      if (stored?.size === row.source_size && row.storage_bytes === row.source_size)
        return json({id,status:"staged",sha256:row.source_file_sha256,reused:true});
      throw new ApiError(409,"Staged master needs reconciliation before another upload.");
    }
    if (row.status !== "pending_review") throw new ApiError(409,"The recording is not awaiting release");
    if (!request.body) throw new ApiError(400,"Original audio stream required");
    const announced=request.headers.get("content-length");
    if (!announced || Number(announced)!==row.source_size)
      throw new ApiError(413,"Exact approved original byte count required");
    const mime=request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (mime!==row.mime && !(mime==="application/ogg" && row.mime==="audio/ogg"))
      throw new ApiError(422,"Incorrect original media MIME");
    // R2 independently verifies the supplied SHA-256 while consuming the
    // stream; unlike a metadata-only check this rejects changed originals.
    const key="soundtracks/external/v1/"+id+"/"+row.source_file_sha256+(row.mime==="audio/mpeg"?".mp3":".ogg");
    await env.BUCKET.put(key,request.body,{sha256:row.source_file_sha256,
      httpMetadata:{contentType:row.mime},customMetadata:{source:row.provider,id}});
    const head=await env.BUCKET.head?.(key);
    if (!head || head.size!==row.source_size) {
      await env.BUCKET.delete(key);
      throw new ApiError(409,"Object storage did not confirm exact original size");
    }
    const updated=await env.DB.prepare(
      "UPDATE soundtrack_external_recordings SET status='staged',storage_key=?,storage_bytes=?,updated_at=? WHERE id=? AND status='pending_review' RETURNING id"
    ).bind(key,head.size,timestamp(),id).first();
    if (!updated) throw new ApiError(409,"Release state changed during upload");
    await event(env,id,actor,"uploaded",{sha256:row.source_file_sha256,bytes:head.size,key});
    return json({id,status:"staged",sha256:row.source_file_sha256});
  }
  if (action==="approve" && request.method==="POST") {
    // Rights judgments cannot be delegated to an unattended machine runner.
    if (!staff || staff.aal!=="aal2") throw new ApiError(403,"External master release requires an authenticated human staff reviewer with MFA.");
    if (row.status!=="staged" || !row.storage_key || !row.storage_bytes)
      throw new ApiError(409,"Original must be staged before rights approval");
    const input=z.object({provenanceSha256:z.string().regex(/^[a-f0-9]{64}$/),
      assessment:z.string().trim().min(100).max(4000),
      sourceLicenseChecked:z.literal(true),providerPermissionChecked:z.literal(true),
      exactMasterListened:z.literal(true)}).parse(await readBody(request,7000));
    if (input.provenanceSha256!==row.provenance_sha256)
      throw new ApiError(409,"Rights evidence changed since review");
    const report=soundtrackQualitySchema.parse(JSON.parse(row.quality_report_json));
    if (!qualityPasses(report)||report.sha256!==row.source_file_sha256||report.sourceSha1!==row.source_file_sha1||
        report.bytes!==row.source_size) throw new ApiError(409,"Invalid original audio QA evidence");
    const head=await env.BUCKET?.head?.(row.storage_key);
    if (!head || head.size!==row.source_size) throw new ApiError(503,"Stored original is unavailable");
    const at=timestamp(), reviewer="staff:"+staff.id, eventId=crypto.randomUUID();
    const payload={provenanceSha256:row.provenance_sha256,assessment:input.assessment,
      staffConfirmation:{sourceLicense:true,providerPermission:true,exactMasterListened:true}};
    // Status transition and immutable rights decision are one D1 transaction.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE soundtrack_external_recordings SET status='ready',reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=? AND status='staged' AND provenance_sha256=?"
      ).bind(reviewer,at,at,id,row.provenance_sha256),
      env.DB.prepare(
        "INSERT INTO soundtrack_external_events(id,recording_id,actor,event_type,payload_json,created_at) SELECT ?,id,?,'approved',?,? FROM soundtrack_external_recordings WHERE id=? AND status='ready' AND reviewed_at=?"
      ).bind(eventId,reviewer,JSON.stringify(payload),at,id,at),
    ]);
    if (!(await env.DB.prepare("SELECT id FROM soundtrack_external_events WHERE id=?").bind(eventId).first()))
      throw new ApiError(409,"Review changed; refresh");
    return json({id,status:"ready"});
  }
  if ((action==="revoke" || action==="reject") && request.method==="POST") {
    const input=z.object({reason:z.string().trim().min(20).max(4000)}).parse(await readBody(request,6500));
    if (row.status==="revoked" || row.status==="rejected") return json({id,status:row.status});
    const next=action==="revoke"?"revoked":"rejected";
    // Withdrawal, audit and durable storage-cleanup work are one transaction.
    const at=timestamp(), eventId=crypto.randomUUID();
    const batch=[
      env.DB.prepare("UPDATE soundtrack_external_recordings SET status=?,storage_key=NULL,storage_bytes=NULL,updated_at=? WHERE id=?")
        .bind(next,at,id),
      env.DB.prepare(
        "INSERT INTO soundtrack_external_events(id,recording_id,actor,event_type,payload_json,created_at) SELECT ?,id,?,?,?,? FROM soundtrack_external_recordings WHERE id=? AND status=?"
      ).bind(eventId,actor,next,JSON.stringify({reason:input.reason,previous:row.status}),at,id,next),
    ];
    if (row.storage_key) batch.push(env.DB.prepare(
      "INSERT OR IGNORE INTO soundtrack_cleanup_queue(storage_key,recording_id,created_at) VALUES(?,?,?)"
    ).bind(row.storage_key,id,at));
    await env.DB.batch(batch);
    if (!(await env.DB.prepare("SELECT id FROM soundtrack_external_events WHERE id=?").bind(eventId).first()))
      throw new ApiError(409,"Withdrawal state changed; refresh");
    if (row.storage_key && env.BUCKET) {
      try {
        await env.BUCKET.delete(row.storage_key);
        await env.DB.prepare("DELETE FROM soundtrack_cleanup_queue WHERE storage_key=?").bind(row.storage_key).run();
      } catch (error) { console.warn("External soundtrack cleanup queued",id,String(error).slice(0,120)); }
    }
    return json({id,status:next});
  }
  return null;
}
