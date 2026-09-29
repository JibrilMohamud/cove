import { api } from "./client";

type RegisteredClient={clientId:string;cursor:number;name:string;platform:string;capabilities?:Record<string,any>};
let cached:{userId:string;promise:Promise<RegisteredClient>}|null=null;

function browserKey(){
  const storageKey="fore:sync-client-key:v1";
  let value="";
  try{value=localStorage.getItem(storageKey)||"";}catch{}
  if(value.length>=24)return value;
  const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
  value=[...bytes].map((x)=>x.toString(16).padStart(2,"0")).join("");
  try{localStorage.setItem(storageKey,value);}catch{}
  return value;
}
export function ensureSyncClient(userId:string){
  if(cached?.userId===userId)return cached.promise;
  const promise=api<RegisteredClient>("/sync/register","POST",{
    clientKey:browserKey(),name:"Cove Web Reader",platform:"web",appVersion:"fore-web-v1",
    capabilities:{reader:true,offlineStorage:typeof indexedDB!=="undefined",push:typeof PushManager!=="undefined",userAgent:navigator.userAgent.slice(0,240)},
  });
  cached={userId,promise};return promise;
}
export async function loadSyncedReaderSettings(userId:string){
  await ensureSyncClient(userId);
  return api<{settings:Record<string,{value:any;version:number;updatedAt:string}>}>("/reader/settings");
}
export async function saveSyncedReaderSetting(userId:string,key:string,value:any,expectedVersion:number){
  const client=await ensureSyncClient(userId);
  return api<{saved:true;version:number;updatedAt:string}>("/reader/settings","POST",{clientId:client.clientId,key,value,expectedVersion});
}
