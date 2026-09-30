import {z} from 'zod';
import {catalogInsert,type CoveEnv} from './api.server';
import {commercialCatalogStatements} from './catalog-model.server';
import {syncSearchIndex} from './search.server';
import {ApiError,json,now,readBody,requireIdentity,rateLimit} from './service';
import {requireServiceScope} from './privileged-access.server';
import {audioSchema,getEdition,insertEdition,objectKey,rowEdition,parseRange} from './audio.server';
import {compareCfi,wordAtAudio,type TimingMap} from './biosync';
import {recordSyncProjection} from './sync.server';
const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const cfi=z.string().max(3000).regex(/^epubcfi\(\/\d+(?:\/\d+(?:\[[^\]]*\])?)*!\/\d+(?:\/\d+(?:\[[^\]]*\])?)*:\d+\)$/);
const digest=async(b:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b as BufferSource))).map(x=>x.toString(16).padStart(2,'0')).join('');
const mapKey=(h:string)=>`biosync/maps/${h}.json`,textKey=(h:string)=>`biosync/text/${h}.epub`;
const pgUrl=z.string().url().refine(s=>{const u=new URL(s);return u.protocol==='https:'&&['www.gutenberg.org','gutenberg.org'].includes(u.hostname)&&!u.username&&!u.password&&!u.port;});
async function queue(env:CoveEnv,key:string,kind:string,payload:any,refresh=false){const at=now();await env.DB.prepare(`INSERT INTO audio_jobs(id,kind,payload_json,status,next_attempt_at,updated_at) VALUES(?,?,?,'queued',?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,status='queued',attempts=0,next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at WHERE ?=1 AND audio_jobs.status IN ('done','skipped') AND audio_jobs.updated_at<?`).bind(key,kind,JSON.stringify(payload),at,at,refresh?1:0,new Date(Date.now()-7*86400000).toISOString()).run();}
export async function handlePipeline(r:Request,env:CoveEnv,path:string,userId:string|null):Promise<Response|null>{
  const method=r.method,url=new URL(r.url),db=env.DB;
  if(path==='/audio-status'&&method==='GET'){
    const [jobs,last,checked]=await Promise.all([db.prepare('SELECT status,COUNT(*) count FROM audio_jobs GROUP BY status').all(),db.prepare("SELECT MAX(updated_at) stamp FROM audio_jobs WHERE status='done'").first<any>(),db.prepare('SELECT COUNT(*) count FROM audio_timing').first<any>()]);return json({jobs:jobs.results,lastSuccessAt:last?.stamp,checkedTracks:checked?.count||0});
  }
  const resource=path.match(/^\/audio\/([^/]+)\/(text|alignment\/([^/]+))$/);
  if(resource&&['GET','HEAD'].includes(method)){
    const e=await getEdition(env,resource[1]);let key:string,mime:string,checksum:string;
    if(resource[2]==='text'){if(!e.epubSha256)throw new ApiError(404,'Matching text is still being prepared.');checksum=e.epubSha256;key=textKey(checksum);mime='application/epub+zip';}
    else {const map=e.alignment?.maps?.find(m=>m.trackId===resource[3]);if(!map||(url.searchParams.has('sha')&&url.searchParams.get('sha')!==map.sha256))throw new ApiError(404,'Checked timing unavailable for this track.');checksum=map.sha256;key=mapKey(checksum);mime='application/json';}
    const meta=await env.BUCKET?.head?.(key);if(!meta)throw new ApiError(404,'This synchronized file is unavailable.');
    const range=parseRange(r.headers.get('Range'),meta.size);const object=method==='HEAD'?null:await env.BUCKET!.get(key,range?{range}:undefined);
    return new Response(object?.body||null,{status:range?206:200,headers:{'Content-Type':mime,'Content-Length':String(range?.length||meta.size),'Accept-Ranges':'bytes','Cache-Control':'private, max-age=86400','ETag':`"${checksum}"`,...(range?{'Content-Range':`bytes ${range.offset}-${range.offset+range.length-1}/${meta.size}`}:{})}});
  }
  const position=path.match(/^\/biosync\/(\d+)$/);
  if(position){const uid=requireIdentity(userId),bookId=position[1];
    if(method==='GET')return json(await db.prepare('SELECT * FROM biosync_positions WHERE user_id=? AND book_id=?').bind(uid,bookId).first());
    if(method==='PUT'){
      await rateLimit(env,'biosync:'+uid,120);const p=z.object({editionId:id,trackId:id,seconds:z.number().min(0).max(86400),cfi,mode:z.enum(['text','audio']),epubSha256:hash,audioSha256:hash,version:z.number().int().min(0)}).parse(await readBody(r));
      const e=await getEdition(env,p.editionId),track=e.tracks.find(t=>t.id===p.trackId);if(e.bookId!==bookId||e.epubSha256!==p.epubSha256||track?.sha256!==p.audioSha256)throw new ApiError(409,'The synchronized edition changed. Reopen the book.');
      const summary=e.alignment?.maps?.find(m=>m.trackId===p.trackId),object=summary&&await env.BUCKET?.get(mapKey(summary.sha256));if(!object)throw new ApiError(409,'No checked timing for this track.');
      const map=await new Response(object.body).json() as TimingMap,w=wordAtAudio(map,p.seconds);if(!w||compareCfi(p.cfi,w.cfi)!==0)throw new ApiError(400,'Position does not match a checked passage.');
      const at=now();const row=p.version===0?await db.prepare('INSERT INTO biosync_positions(user_id,book_id,edition_id,mode,cfi,track_id,seconds,epub_sha256,audio_sha256,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(user_id,book_id) DO NOTHING RETURNING version,updated_at').bind(uid,bookId,e.id,p.mode,p.cfi,p.trackId,p.seconds,p.epubSha256,p.audioSha256,at).first<any>():await db.prepare('UPDATE biosync_positions SET edition_id=?,mode=?,cfi=?,track_id=?,seconds=?,epub_sha256=?,audio_sha256=?,version=version+1,updated_at=? WHERE user_id=? AND book_id=? AND version=? RETURNING version,updated_at').bind(e.id,p.mode,p.cfi,p.trackId,p.seconds,p.epubSha256,p.audioSha256,at,uid,bookId,p.version).first<any>();
      if(!row)throw new ApiError(409,'Biosync moved on another device. Reload before continuing.');await recordSyncProjection(db,{userId:uid,entityType:'biosync_location',entityId:bookId,payload:{bookId,editionId:e.id,trackId:p.trackId,seconds:p.seconds,cfi:p.cfi,mode:p.mode},explicitVersion:Number(row.version)});return json(row);
    }
  }
  if(!path.startsWith('/pipeline/'))return null;
  await requireServiceScope(db as any,r,path==='/pipeline/book'?'catalog.ingest':'audio.prepare');
  if(path==='/pipeline/discover'&&method==='POST'){
    const p=z.object({items:z.array(z.object({gutenbergId:z.string().regex(/^\d{1,9}$/),candidates:z.array(z.string().regex(/^\d{1,9}$/)).max(8),title:z.string().max(1000)})).max(100)}).parse(await readBody(r,200000));for(const item of p.items)await queue(env,'discover-'+item.gutenbergId,'discover',item,true);return json({queued:p.items.length});
  }
  if(path==='/pipeline/claim'&&method==='POST'){
    const p=z.object({kind:z.enum(['discover','track','align']).optional()}).parse(await readBody(r));const at=now(),until=new Date(Date.now()+10*60000).toISOString();
    await db.prepare("UPDATE audio_jobs SET status='review',last_error='Repeated worker lease expiry',updated_at=? WHERE status='running' AND lease_until<? AND attempts>=6").bind(at,at).run();
    const job=await db.prepare(`UPDATE audio_jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=(SELECT id FROM audio_jobs WHERE (status='queued' AND next_attempt_at<=? OR status='running' AND lease_until<?) AND attempts<6 ${p.kind?'AND kind=?':''} ORDER BY CASE kind WHEN 'discover' THEN 0 WHEN 'track' THEN 1 ELSE 2 END,updated_at,id LIMIT 1) RETURNING *`).bind(crypto.randomUUID(),until,at,at,at,...(p.kind?[p.kind]:[])).first<any>();return json(job?{...job,payload:JSON.parse(job.payload_json),payload_json:undefined}:null);
  }
  const jobPath=path.match(/^\/pipeline\/jobs\/([a-zA-Z0-9_-]+)$/);
  if(jobPath&&method==='PUT'){
    const p=z.object({leaseToken:z.string().uuid(),status:z.enum(['done','review','skipped','retry','heartbeat']),error:z.string().max(1000).default('')}).parse(await readBody(r));
    const job=await db.prepare("SELECT * FROM audio_jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?").bind(jobPath[1],p.leaseToken,now()).first<any>();if(!job)throw new ApiError(409,'Job lease expired.');
    if(p.status==='heartbeat'){await db.prepare('UPDATE audio_jobs SET lease_until=? WHERE id=? AND lease_token=?').bind(new Date(Date.now()+10*60000).toISOString(),job.id,p.leaseToken).run();return json({renewed:true});}
    const status=p.status==='retry'?(job.attempts>=6?'review':'queued'):p.status,next=new Date(Date.now()+(p.status==='retry'?Math.min(86400,60*2**job.attempts)*1000:0)).toISOString();await db.prepare('UPDATE audio_jobs SET status=?,next_attempt_at=?,last_error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?').bind(status,next,p.error,now(),job.id,p.leaseToken).run();return json({status});
  }
  if(path==='/pipeline/retire'&&method==='POST'){const p=z.object({gutenbergId:z.string().regex(/^\d{1,9}$/)}).parse(await readBody(r));await db.prepare("UPDATE audio_editions SET rights='Unavailable',alignment_json=NULL,updated_at=? WHERE gutenberg_id=?").bind(now(),p.gutenbergId).run();return json({retired:true});}
  if(path==='/pipeline/book'&&method==='PUT'){
    const b=z.object({id:z.string().regex(/^\d{1,9}$/),title:z.string().min(1).max(1000),authors:z.array(z.object({name:z.string().max(300)})).max(40),copyright:z.literal(false),subjects:z.array(z.string().max(500)).max(100),bookshelves:z.array(z.string().max(500)).max(100),languages:z.array(z.string().max(10)).max(20),formats:z.record(pgUrl),download_count:z.number().min(0)}).parse(await readBody(r,100000));const at=now();await catalogInsert(db,b,'https://www.gutenberg.org/ebooks/'+b.id,at).run();await db.batch(commercialCatalogStatements(db,b.id,at));await syncSearchIndex(env,20).catch(()=>{});return json({saved:true});
  }
  if(path==='/pipeline/edition'&&method==='PUT'){
    const p=z.object({edition:audioSchema,fingerprints:z.record(hash)}).parse(await readBody(r,1000000));const e=p.edition;
    if(e.tracks.some(t=>!p.fingerprints[t.id]))throw new ApiError(400,'Every track requires a source fingerprint.');
    const row=await db.prepare('SELECT * FROM audio_editions WHERE id=?').bind(e.id).first<any>();
    if(row){const old=rowEdition(row);for(const t of e.tracks){const previous=old.tracks.find(v=>v.id===t.id&&v.url===t.url&&v.bytes===t.bytes);if(previous)Object.assign(t,previous);}if(e.bookId===old.bookId){e.epubSha256=old.epubSha256;e.alignment=old.alignment as any;}if(e.narration==='unknown')e.narration=old.narration;if(!e.narrator)e.narrator=old.narrator;}
    // Prepared maps are published through the separate checked endpoint.
    await insertEdition(env,e).run();
    for(const t of e.tracks)await queue(env,`track-${e.id}-${t.id}-${p.fingerprints[t.id].slice(0,16)}`,'track',{editionId:e.id,trackId:t.id,sourceUrl:t.url,fingerprint:p.fingerprints[t.id]});
    return json({id:e.id});
  }
  const upload=path.match(/^\/pipeline\/media\/([^/]+)\/([^/]+)$/);
  if(upload&&method==='PUT'){
    if(!env.BUCKET)throw new ApiError(503,'Audio storage unavailable.');const e=await getEdition(env,upload[1]),t=e.tracks.find(t=>t.id===upload[2]);
    const checksum=hash.parse(r.headers.get('x-content-sha256')),duration=z.coerce.number().positive().max(86400).parse(r.headers.get('x-audio-duration')),size=z.coerce.number().int().positive().max(512*1024*1024).parse(r.headers.get('content-length'));
    if(!t||r.headers.get('x-source-url')!==t.url||(t.bytes&&t.bytes!==size))throw new ApiError(409,'Audio source changed during preparation.');
    const key=objectKey(e,{...t,sha256:checksum});if(!await env.BUCKET.head?.(key))await env.BUCKET.put(key,r.body,{sha256:checksum,httpMetadata:{contentType:t.mime}});
    const n=e.tracks.findIndex(v=>v.id===t.id);await db.prepare('UPDATE audio_editions SET tracks_json=json_set(tracks_json,?,json(?)),updated_at=? WHERE id=? AND json_extract(tracks_json,?)=?').bind(`$[${n}]`,JSON.stringify({...t,sha256:checksum,duration,bytes:size}),now(),e.id,`$[${n}].url`,t.url).run();
    if(e.bookId)await queue(env,`align-${e.id}-${t.id}-${checksum.slice(0,16)}`,'align',{editionId:e.id,trackId:t.id,audioSha256:checksum});
    return json({stored:true,sha256:checksum,alignmentQueued:Boolean(e.bookId)});
  }
  const textUpload=path.match(/^\/pipeline\/text\/([^/]+)$/);
  if(textUpload&&method==='PUT'){
    if(!env.BUCKET)throw new ApiError(503,'Text storage unavailable.');const e=await getEdition(env,textUpload[1]),checksum=hash.parse(r.headers.get('x-content-sha256'));z.coerce.number().positive().max(25*1024*1024).parse(r.headers.get('content-length'));
    if(!e.bookId||r.headers.get('x-book-id')!==e.bookId||e.epubSha256&&e.epubSha256!==checksum)throw new ApiError(409,'This recording already uses a different pinned text.');
    if(!await env.BUCKET.head?.(textKey(checksum)))await env.BUCKET.put(textKey(checksum),r.body,{sha256:checksum,httpMetadata:{contentType:'application/epub+zip'}});
    await db.prepare('UPDATE audio_editions SET epub_sha256=? WHERE id=? AND (epub_sha256 IS NULL OR epub_sha256=?)').bind(checksum,e.id,checksum).run();return json({stored:true});
  }
  const timing=path.match(/^\/pipeline\/alignment\/([^/]+)\/([^/]+)$/);
  if(timing&&method==='PUT'){
    if(!env.BUCKET)throw new ApiError(503,'Timing storage unavailable.');
    const word=z.object({cfi,endCfi:cfi,href:z.string().min(1).max(2000).refine(s=>!s.includes('..')&&!/^\w+:|^\//.test(s)),text:z.string().min(1).max(300),start:z.number().min(0),end:z.number().positive(),wordIndex:z.number().int().min(0),probability:z.number().min(.72).max(1)});
    const map=z.object({version:z.literal(2),status:z.literal('checked'),trackId:id,epubSha256:hash,audioSha256:hash,duration:z.number().positive(),engine:z.string().max(200),words:z.array(word).min(30).max(100000),verification:z.object({method:z.literal('independent-asr-exact-text'),automatic:z.literal(true),minWordProbability:z.number().min(.72),matchedWords:z.number().int().min(30),spokenWords:z.number().int().min(30),coverage:z.number().min(.8).max(1),checkedAt:z.string().datetime()})}).parse(await readBody(r,16*1024*1024));
    const e=await getEdition(env,timing[1]),t=e.tracks.find(t=>t.id===timing[2]);if(!t?.sha256||map.trackId!==t.id||map.audioSha256!==t.sha256||map.epubSha256!==e.epubSha256||!t.duration||Math.abs(t.duration-map.duration)>1)throw new ApiError(409,'Timing must match the exact recording and EPUB files.');
    if(map.words.length!==map.verification.matchedWords||map.verification.matchedWords>map.verification.spokenWords)throw new ApiError(400,'Verification counts disagree.');
    let last=-1,previous:any=null;for(const w of map.words){if(w.start<last||w.end<=w.start||w.end>map.duration||w.probability<map.verification.minWordProbability||compareCfi(w.cfi,w.endCfi)>=0||(previous&&(w.wordIndex<=previous.wordIndex||compareCfi(previous.endCfi,w.cfi)>0)))throw new ApiError(400,'Invalid or unordered timing words.');last=w.end;previous=w;}
    const bytes=new TextEncoder().encode(JSON.stringify(map)),checksum=await digest(bytes),first=map.words[0],lastWord=map.words.at(-1)!;const summary={trackId:t.id,sha256:checksum,wordCount:map.words.length,coverage:map.verification.coverage,firstCfi:first.cfi,lastCfi:lastWord.endCfi,firstSecond:first.start,lastSecond:lastWord.end};
    await env.BUCKET.put(mapKey(checksum),bytes,{sha256:checksum,httpMetadata:{contentType:'application/json'}});
    await db.prepare('INSERT INTO audio_timing(edition_id,track_id,audio_sha256,epub_sha256,map_sha256,summary_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(edition_id,track_id) DO UPDATE SET audio_sha256=excluded.audio_sha256,epub_sha256=excluded.epub_sha256,map_sha256=excluded.map_sha256,summary_json=excluded.summary_json,updated_at=excluded.updated_at').bind(e.id,t.id,map.audioSha256,map.epubSha256,checksum,JSON.stringify(summary),now()).run();return json({checked:true,...summary});
  }
  return null;
}
