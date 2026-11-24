/* eslint-disable prettier/prettier -- exact production endpoint and sanitized provider evidence */
import {pathToFileURL} from "node:url";
export const endpoint="https://cove-biosync-production-ingress.cove-jibrilmohamud.workers.dev/__cove/biosync/publish-checked";
const fields=["editionId","jobId","mapSha256","trackId"];
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{2,160}$/.test(x);
export function validCommand(x){
  return !!x&&typeof x==="object"&&Object.keys(x).sort().join(",")===fields.join(",")&&
    id(x.editionId)&&id(x.trackId)&&id(x.jobId)&&typeof x.mapSha256==="string"&&/^[a-f0-9]{64}$/.test(x.mapSha256);
}
export function ownerBoundary(response){
  return response.headers.get("cache-control")==="no-store"&&response.headers.get("x-content-type-options")==="nosniff";
}
export function refusalCode(response){
  const layer=ownerBoundary(response)?"application":response.headers.get("cf-mitigated")==="challenge"?"edge_challenge":"edge_or_transport";
  return "biosync_owner_"+layer+"_http_"+response.status;
}
export async function sendOwner(payload,token,transport=fetch,{probe=false}={}){
  if(!validCommand(payload)&&!(probe&&payload&&Object.keys(payload).length===0))
    throw Error("biosync_owner_invalid_command");
  if(token!==""&&!/^[a-f0-9]{64}$/.test(token))throw Error("biosync_owner_invalid_token");
  if(!probe&&!token)throw Error("biosync_owner_invalid_token");
  return transport(endpoint,{method:"POST",headers:{"content-type":"application/json",
    ...(token?{authorization:"Bearer "+token}:{})},
    body:JSON.stringify(payload),redirect:"error",signal:AbortSignal.timeout(120000)});
}
export async function commitOwner(payload,token,transport=fetch){
  const response=await sendOwner(payload,token,transport);
  if(response.status!==200||!ownerBoundary(response)){
    await response.body?.cancel();throw Error(refusalCode(response));
  }
  const reader=response.body?.getReader();
  if(!reader)throw Error("biosync_owner_receipt_missing");
  let n=0;const chunks=[];
  try{
    for(;;){const p=await reader.read();if(p.done)break;n+=p.value.byteLength;
      if(n>4096){await reader.cancel();throw Error("biosync_owner_receipt_bound");}chunks.push(p.value);}
  }finally{reader.releaseLock();}
  const receipt=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if(!receipt||Object.keys(receipt).sort().join(",")!==[...fields,"schema","committed","replay"].sort().join(",")||
    receipt.schema!=="cove.owner-biosync-checked-publication.v1"||receipt.committed!==true||
    typeof receipt.replay!=="boolean"||fields.some(k=>receipt[k]!==payload[k]))
    throw Error("biosync_owner_receipt_mismatch");
  return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const chunks=[];let n=0;
    for await(const chunk of process.stdin){n+=chunk.length;if(n>1024)throw Error("biosync_owner_command_bound");chunks.push(chunk);}
    const receipt=await commitOwner(JSON.parse(Buffer.concat(chunks).toString("utf8")),process.env.COVE_BIOSYNC_PROD_CLIENT_SECRET||"");
    console.log(JSON.stringify(receipt));
  }catch(error){
    const message=String(error?.message||"");
    console.error(/^biosync_owner_[a-z0-9_]+$/.test(message)?message:"biosync_owner_transport_failed");
    process.exitCode=1;
  }
}
