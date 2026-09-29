import {api,type CatalogBook} from './client';
import {getRecord,putRecord,sha256} from './offline';
import type {AudioEdition} from './domain';
import {compareCfi,wordAtAudio,wordAtText,type TimingMap,type TimingWord} from './biosync';
const loaded=new Map<string,Promise<TimingMap>>();
export const timingKey=(h:string)=>'biosync:map:'+h;
export async function loadTiming(e:AudioEdition,trackId:string,signal?:AbortSignal):Promise<TimingMap|null>{
  const summary=e.alignment?.maps?.find(m=>m.trackId===trackId),track=e.tracks.find(t=>t.id===trackId);if(!summary||!track?.sha256)return null;
  const key=timingKey(summary.sha256);
  if(!loaded.has(key))loaded.set(key,(async()=>{
    const local=await getRecord('assets',key).catch(()=>null);let bytes:ArrayBuffer;
    if(local?.blob)bytes=await local.blob.arrayBuffer();else{const r=await fetch(`/api/fore/audio/${e.id}/alignment/${trackId}?sha=${summary.sha256}`,{signal});if(!r.ok)throw Error('Biosync timing is unavailable for this track.');bytes=await r.arrayBuffer();}
    if(await sha256(bytes)!==summary.sha256)throw Error('Timing map integrity check failed.');const map=JSON.parse(new TextDecoder().decode(bytes)) as TimingMap;
    if(map.audioSha256!==track.sha256||map.epubSha256!==e.epubSha256||map.status!=='checked')throw Error('Biosync files do not match this edition.');
    if(!local)await putRecord('assets',{id:key,blob:new Blob([bytes],{type:'application/json'})}).catch(()=>{});return map;
  })().catch(error=>{loaded.delete(key);throw error;}));return loaded.get(key)!;
}
export async function resolveAudio(e:AudioEdition,trackId:string,seconds:number){const map=await loadTiming(e,trackId),word=map&&wordAtAudio(map,seconds);return word?{word,trackId,seconds}:null;}
export async function resolveText(e:AudioEdition,cfi:string,epubHash:string){
  if(epubHash!==e.epubSha256)return null;const node=(s:string)=>s.replace(/:\d+\)$/,')');
  for(const s of e.alignment?.maps||[]){if((compareCfi(s.firstCfi,cfi)<=0||node(s.firstCfi)===node(cfi))&&compareCfi(cfi,s.lastCfi)<=0){const map=await loadTiming(e,s.trackId),word=map&&wordAtText(map,cfi);if(word)return {word,trackId:s.trackId,seconds:word.start};}}return null;
}
export function editionBook(e:AudioEdition):CatalogBook{return {id:e.bookId!,title:e.title,authors:e.authors,subjects:[],bookshelves:[],languages:[e.language],formats:{},download_count:0,copyright:false};}
export async function matchingEpub(e:AudioEdition){
  if(!e.epubSha256)throw Error('Matching text is still being prepared.');const key='epub:sha:'+e.epubSha256,local=await getRecord('assets',key).catch(()=>null);
  let bytes:ArrayBuffer;if(local?.blob)bytes=await local.blob.arrayBuffer();else{const r=await fetch(`/api/fore/audio/${e.id}/text`);if(!r.ok)throw Error('Download the matching text to use Biosync offline.');bytes=await r.arrayBuffer();}
  if(await sha256(bytes)!==e.epubSha256)throw Error('Text integrity check failed.');
  if(!local)await putRecord('assets',{id:key,blob:new Blob([bytes],{type:'application/epub+zip'})}).catch(()=>{});
  await putRecord('assets',{id:'book-meta:'+e.bookId,book:editionBook(e)}).catch(()=>{});return bytes;
}
export type SyncPosition={edition_id:string;track_id:string;seconds:number;cfi:string;mode:'text'|'audio';epub_sha256:string;audio_sha256:string;version:number;updated_at:string;pending?:boolean};
export async function openBiosync(bookId:string,uid:string|null){
  const key=`biosync:position:${uid||'guest'}:${bookId}`;let current:SyncPosition|null=await getRecord('assets',key).catch(()=>null)||null;
  if(uid){try{const remote=await api('/biosync/'+bookId);if(!current?.pending||current.version!==(remote?.version||0))current=remote;}catch(error){if((error as any).status&&(error as any).status!==503)throw error;}}
  let chain=Promise.resolve(),blocked=false;
  return {get current(){return current;},save(e:AudioEdition,match:{word:TimingWord;trackId:string;seconds:number},mode:'text'|'audio'){
    chain=chain.catch(()=>{}).then(async()=>{if(blocked)throw Error('Biosync moved on another device. Reload before switching.');const t=e.tracks.find(t=>t.id===match.trackId)!;
      const value:SyncPosition={edition_id:e.id,track_id:t.id,seconds:match.seconds,cfi:match.word.cfi,mode,epub_sha256:e.epubSha256!,audio_sha256:t.sha256!,version:current?.version||0,updated_at:new Date().toISOString(),pending:!!uid};
      await putRecord('assets',{id:key,...value});current=value;
      if(uid){try{const result=await api('/biosync/'+bookId,'PUT',{editionId:e.id,trackId:t.id,seconds:value.seconds,cfi:value.cfi,mode,epubSha256:e.epubSha256,audioSha256:t.sha256,version:value.version});current={...value,version:result.version,updated_at:result.updated_at,pending:false};await putRecord('assets',{id:key,...current});}
        catch(error){if((error as any).status===409){blocked=true;throw error;}if((error as any).status&&(error as any).status!==503)throw error;}}
    });return chain;
  }};
}
