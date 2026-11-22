/* eslint-disable prettier/prettier -- Auditable QA-only owner mutation; no caller SQL or positive rights grant. */
import {z} from "zod/v3";
import type {CatalogDB} from "../features/fore/catalog-model.server";

const id=z.string().regex(/^[a-zA-Z0-9_-]{2,160}$/);
const sha=z.string().regex(/^[0-9a-f]{64}$/);
export const biosyncPublicationCommand=z.object({
  editionId:id,trackId:id,jobId:id,mapSha256:sha
}).strict();
type Command=z.infer<typeof biosyncPublicationCommand>;
type Bucket={get(key:string):Promise<{arrayBuffer():Promise<ArrayBuffer>}|null>};
type EditionJob={epub_sha256:string|null;tracks_json:string;status:string;kind:string;payload_json:string};
type TimingRow={map_sha256:string};
const fail=(reason:string):never=>{throw Error("owner_biosync_"+reason);};
const digest=async(bytes:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))]
  .map(b=>b.toString(16).padStart(2,"0")).join("");
const dict=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);

/** The scheduled job may nominate one immutable R2 digest, never SQL, paths,
 * authorization, a summary, or a state transition. The owner re-verifies the
 * complete map and commits its timing pointer and job state in one D1 batch.
 * A failed/missing owner or R2 response never produces an acknowledgement.
 * A checked timing map is reader metadata, not an entitlement or legal grant.
 */
export async function publishCheckedBiosyncOwned(
  db:CatalogDB,bucket:Bucket|undefined,raw:unknown
) {
  const x:Command=biosyncPublicationCommand.parse(raw);
  if(!bucket)fail("bucket_unavailable");
  const object=await bucket.get("biosync/maps/"+x.mapSha256+".json");
  if(!object)fail("map_missing");
  const bytes=await object.arrayBuffer();
  if(bytes.byteLength<512||bytes.byteLength>8_000_000)fail("map_size_invalid");
  if(await digest(bytes)!==x.mapSha256)fail("map_digest_mismatch");
  let map:unknown;
  try{map=JSON.parse(new TextDecoder().decode(bytes));}
  catch{fail("map_invalid_json");}
  if(!dict(map)||!dict(map.verification)||!Array.isArray(map.words)||
     map.version!==2||map.status!=="checked"||map.trackId!==x.trackId||
     map.engine!=="cloudflare-workers-ai-whisper"||
     map.verification.method!=="independent-asr-exact-text"||
     map.verification.confidenceMode!=="unreported"||
     map.verification.minWordProbability!==null||
     !Number.isFinite(map.verification.coverage)||
     Number(map.verification.coverage)<0.9||Number(map.verification.coverage)>1||
     !Number.isSafeInteger(map.verification.matchedWords)||
     map.verification.matchedWords!==map.words.length||
     !Number.isSafeInteger(map.verification.spokenWords)||
     Number(map.verification.spokenWords)<map.words.length||
     map.words.length<30||map.words.length>120_000||
     !Number.isFinite(map.duration)||Number(map.duration)<=0||
     Number(map.duration)>43_200||
     !sha.safeParse(map.audioSha256).success||
     !sha.safeParse(map.epubSha256).success)fail("verification_invalid");
  let previousEnd=-1,previousIndex=-1;
  for(const item of map.words){
    if(!dict(item)||!Number.isSafeInteger(item.wordIndex)||Number(item.wordIndex)<=previousIndex||
       !Number.isFinite(item.start)||!Number.isFinite(item.end)||
       Number(item.start)<previousEnd||Number(item.start)>=Number(item.end)||
       Number(item.end)>Number(map.duration)||item.probability!==null||
       typeof item.href!=="string"||item.href.length>500||item.href.includes("..")||
       typeof item.cfi!=="string"||!item.cfi.startsWith("epubcfi(")||
       typeof item.endCfi!=="string"||!item.endCfi.startsWith("epubcfi(")||
       typeof item.text!=="string"||item.text.length===0||item.text.length>250)
      fail("word_identity_invalid");
    previousEnd=Number(item.end);previousIndex=Number(item.wordIndex);
  }
  const row=await db.prepare(
    "SELECT e.epub_sha256,e.tracks_json,j.status,j.kind,j.payload_json "+
    "FROM audio_editions e JOIN audio_jobs j ON j.id=? WHERE e.id=?"
  ).bind(x.jobId,x.editionId).first<EditionJob>();
  if(!row||row.kind!=="align"||!["queued","review","done"].includes(row.status))
    fail("job_not_eligible");
  let tracks:unknown,payload:unknown;
  try{tracks=JSON.parse(row.tracks_json);payload=JSON.parse(row.payload_json);}
  catch{fail("job_identity_invalid");}
  if(!Array.isArray(tracks)||!dict(payload)||
     payload.editionId!==x.editionId||payload.trackId!==x.trackId||
     payload.audioSha256!==map.audioSha256||row.epub_sha256!==map.epubSha256)
    fail("job_identity_mismatch");
  const track=tracks.find(t=>dict(t)&&t.id===x.trackId);
  if(!dict(track)||track.sha256!==map.audioSha256||
     !Number.isFinite(Number(track.duration))||
     Math.abs(Number(track.duration)-Number(map.duration))>1)
    fail("recording_changed");
  const old=await db.prepare(
    "SELECT map_sha256 FROM audio_timing WHERE edition_id=? AND track_id=?"
  ).bind(x.editionId,x.trackId).first<TimingRow>();
  if(old&&old.map_sha256!==x.mapSha256)fail("conflicting_publication");
  if(row.status==="done"){
    if(!old||old.map_sha256!==x.mapSha256)fail("incomplete_prior_publication");
    return {schema:"cove.owner-biosync-checked-publication.v1",...x,committed:true,replay:true};
  }
  if(old)fail("timing_without_completed_job");
  const first=map.words[0] as Record<string,unknown>;
  const last=map.words[map.words.length-1] as Record<string,unknown>;
  const summary=JSON.stringify({
    trackId:x.trackId,sha256:x.mapSha256,wordCount:map.words.length,
    coverage:map.verification.coverage,firstCfi:first.cfi,lastCfi:last.endCfi,
    firstSecond:first.start,lastSecond:last.end
  });
  const at=new Date().toISOString();
  // D1.batch is transactional. Both mutations include fresh job/edition/track
  // identity predicates. If any competing job claim wins, no success receipt.
  await db.batch([
    db.prepare(
      "INSERT INTO audio_timing(edition_id,track_id,audio_sha256,epub_sha256,map_sha256,summary_json,updated_at) "+
      "SELECT ?,?,?,?,?,?,? WHERE EXISTS ("+
      "SELECT 1 FROM audio_jobs j JOIN audio_editions e ON e.id=? "+
      "JOIN json_each(e.tracks_json) t ON json_extract(t.value,'$.id')=? "+
      "WHERE j.id=? AND j.kind='align' AND j.status IN ('queued','review') "+
      "AND json_extract(j.payload_json,'$.editionId')=? "+
      "AND json_extract(j.payload_json,'$.trackId')=? "+
      "AND json_extract(j.payload_json,'$.audioSha256')=? "+
      "AND e.epub_sha256=? AND json_extract(t.value,'$.sha256')=?) "+
      "ON CONFLICT(edition_id,track_id) DO NOTHING"
    ).bind(x.editionId,x.trackId,map.audioSha256,map.epubSha256,x.mapSha256,summary,at,
      x.editionId,x.trackId,x.jobId,x.editionId,x.trackId,map.audioSha256,map.epubSha256,map.audioSha256),
    db.prepare(
      "UPDATE audio_jobs SET status='done',last_error=?,lease_token=NULL,lease_until=NULL,updated_at=? "+
      "WHERE id=? AND kind='align' AND status IN ('queued','review') "+
      "AND json_extract(payload_json,'$.editionId')=? "+
      "AND json_extract(payload_json,'$.trackId')=? "+
      "AND json_extract(payload_json,'$.audioSha256')=? "+
      "AND EXISTS(SELECT 1 FROM audio_timing t WHERE t.edition_id=? AND t.track_id=? "+
      "AND t.audio_sha256=? AND t.epub_sha256=? AND t.map_sha256=?)"
    ).bind("Verified "+map.words.length+" independent ASR words",at,x.jobId,
      x.editionId,x.trackId,map.audioSha256,x.editionId,x.trackId,map.audioSha256,map.epubSha256,x.mapSha256)
  ]);
  const [finalTiming,finalJob]=await Promise.all([
    db.prepare("SELECT map_sha256 FROM audio_timing WHERE edition_id=? AND track_id=?")
      .bind(x.editionId,x.trackId).first<TimingRow>(),
    db.prepare("SELECT status FROM audio_jobs WHERE id=?").bind(x.jobId).first<{status:string}>()
  ]);
  if(finalTiming?.map_sha256!==x.mapSha256||finalJob?.status!=="done")
    fail("atomic_commit_not_confirmed");
  return {schema:"cove.owner-biosync-checked-publication.v1",...x,committed:true,replay:false};
}
