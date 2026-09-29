import {api} from "./client";

export type CommercialBiosyncCue={chapterId:string;startMs:number;endMs:number;cfi:string;progress:number;endProgress:number};
export type CommercialBiosyncManifest={schemaVersion:1;ebookProductId:string;audiobookProductId:string;ebookAssetVersionId:string;audioManifestSha256:string;precision:"sentence"|"word";cues:CommercialBiosyncCue[]};
type BiosyncState={link:{id:string;ebookProductId:string;audiobookProductId:string;precision:"sentence"|"word";coverageBps:number;timingManifestSha256:string};position:{mode:"text"|"audio";cfi:string;chapter_id:string|null;audio_ms:number;version:number;updated_at:string}|null};
async function digest(bytes:ArrayBuffer){const d=await crypto.subtle.digest("SHA-256",bytes);return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("");}
function validateManifest(value:any):CommercialBiosyncManifest{
  if(!value||value.schemaVersion!==1||!Array.isArray(value.cues)||!value.cues.length)throw new Error("Cove's verified Biosync timing map is malformed.");
  for(const cue of value.cues){if(!cue||typeof cue.chapterId!=="string"||typeof cue.cfi!=="string"||!cue.cfi.startsWith("epubcfi(")||![cue.startMs,cue.endMs,cue.progress,cue.endProgress].every(Number.isFinite))throw new Error("Cove's verified Biosync timing map contains an invalid cue.");}
  return value as CommercialBiosyncManifest;
}
export async function openCommercialBiosync(audioEditionId:string){
  const state=await api<BiosyncState>(`/audio/${encodeURIComponent(audioEditionId)}/biosync`);
  const response=await fetch(`/api/fore/audio/${encodeURIComponent(audioEditionId)}/biosync/timing`,{credentials:"same-origin",headers:{Accept:"application/json"}});
  if(!response.ok)throw new Error((await response.text().catch(()=>""))||"Verified Biosync timing is unavailable.");
  const bytes=await response.arrayBuffer(),actual=await digest(bytes),expected=response.headers.get("X-Cove-Biosync-SHA256")||state.link.timingManifestSha256;
  if(actual!==expected||actual!==state.link.timingManifestSha256)throw new Error("Biosync timing integrity verification failed.");
  const manifest=validateManifest(JSON.parse(new TextDecoder().decode(bytes)));
  if(manifest.audiobookProductId!==state.link.audiobookProductId||manifest.ebookProductId!==state.link.ebookProductId)throw new Error("Biosync timing identities do not match this purchased pair.");
  let version=Number(state.position?.version||0),current=state.position;
  const cueForAudio=(chapterId:string,seconds:number)=>{const ms=Math.max(0,Math.round(seconds*1000));return manifest.cues.find(c=>c.chapterId===chapterId&&ms>=c.startMs&&ms<c.endMs)||manifest.cues.filter(c=>c.chapterId===chapterId&&c.startMs<=ms).at(-1)||null;};
  const cueForProgress=(progress:number)=>{const p=Math.max(0,Math.min(1,progress));return manifest.cues.find(c=>p>=c.progress&&p<c.endProgress)||manifest.cues.filter(c=>c.progress<=p).at(-1)||manifest.cues[0]||null;};
  const save=async(mode:"text"|"audio",cue:CommercialBiosyncCue,audioMs?:number)=>{const result=await api<any>(`/audio/${encodeURIComponent(audioEditionId)}/biosync`,"PUT",{mode,cfi:cue.cfi,chapterId:cue.chapterId,audioMs:Math.max(0,Math.round(audioMs??cue.startMs)),version});version=Number(result.version);current={mode,cfi:cue.cfi,chapter_id:cue.chapterId,audio_ms:Math.max(0,Math.round(audioMs??cue.startMs)),version,updated_at:String(result.updatedAt||new Date().toISOString())};return current;};
  return{state,manifest,get current(){return current;},cueForAudio,cueForProgress,save};
}
