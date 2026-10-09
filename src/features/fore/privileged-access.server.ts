import { z } from "zod";
import { ApiError, now } from "./service";

export type AccessDB = {
  prepare(sql: string): { bind(...values: unknown[]): any; first<T = any>(): Promise<T | null>; all<T = any>(): Promise<{ results: T[] }>; run(): Promise<any> };
  batch(statements: any[]): Promise<unknown>;
};

export type ServicePrincipalContext = { principalId:string; credentialId:string; name:string; ownerTeam:string; environment:string; scopes:Set<string> };

const hex = (bytes: Uint8Array) => [...bytes].map((b)=>b.toString(16).padStart(2,"0")).join("");
const base64url = (bytes: Uint8Array) => {
  let s=""; for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
};
async function sha256(value:string){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))));}
function constantTimeEqual(a:string,b:string){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
async function userAgentHash(request:Request){const ua=(request.headers.get("user-agent")||"").slice(0,1000);return ua?sha256(ua):null;}
function requestId(request:Request){return request.headers.get("x-fore-request-id")||request.headers.get("x-request-id")||`req_${crypto.randomUUID()}`;}

export async function recordPrivilegedAccess(db:AccessDB,request:Request,input:{actorType:"staff"|"service"|"bootstrap"|"system";actorId:string;permissionOrScope:string;outcome:"authorized"|"denied"|"completed"|"failed";status?:number;metadata?:unknown}){
  try{await db.prepare("INSERT INTO privileged_access_audit(id,request_id,actor_type,actor_id,permission_or_scope,method,path,outcome,response_status,ip_country,user_agent_sha256,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(`pa_${crypto.randomUUID()}`,requestId(request),input.actorType,input.actorId,input.permissionOrScope,request.method,new URL(request.url).pathname,input.outcome,input.status??null,(request.headers.get("cf-ipcountry")||"").slice(0,2)||null,await userAgentHash(request),JSON.stringify(input.metadata||{}),now()).run();}catch{}
}

export async function requireServiceScope(db:AccessDB,request:Request,scope:string):Promise<ServicePrincipalContext>{
  const header=request.headers.get("authorization")||"",token=header.startsWith("Bearer ")?header.slice(7).trim():"";
  if(!token.startsWith("fore_svc_")){await recordPrivilegedAccess(db,request,{actorType:"service",actorId:"unknown",permissionOrScope:scope,outcome:"denied",status:401,metadata:{reason:"missing_service_credential"}});throw new ApiError(401,"A scoped Cove service credential is required.");}
  const dot=token.indexOf(".");if(dot<12){await recordPrivilegedAccess(db,request,{actorType:"service",actorId:"unknown",permissionOrScope:scope,outcome:"denied",status:401,metadata:{reason:"malformed_service_credential"}});throw new ApiError(401,"The Cove service credential is invalid.");}
  const prefix=token.slice(0,dot),hash=await sha256(token),candidates=(await db.prepare(`SELECT c.*,p.name,p.owner_team,p.environment,p.status principal_status FROM service_principal_credentials c JOIN service_principals p ON p.id=c.principal_id WHERE c.token_prefix=? AND c.status='active'`).bind(prefix).all<any>()).results;
  const credential=candidates.find((c)=>constantTimeEqual(String(c.token_sha256),hash));
  if(!credential){
    const bootstrap=await db.prepare("SELECT value FROM cove_runtime_config WHERE key='audio_service_token_sha256'").first<{value?:string}>().catch(()=>null);
    const bootstrapHash=String(bootstrap?.value||"").toLowerCase();
    const bootstrapScopes=new Set(["audio.prepare","catalog.ingest"]);
    if(/^[a-f0-9]{64}$/.test(bootstrapHash)&&bootstrapScopes.has(scope)&&constantTimeEqual(bootstrapHash,hash)){
      await recordPrivilegedAccess(db,request,{actorType:"bootstrap",actorId:"svc_audio_pipeline",permissionOrScope:scope,outcome:"authorized",status:200,metadata:{mode:"runtime_config_hash"}});
      return{principalId:"svc_audio_pipeline",credentialId:"runtime_config_hash",name:"Cove audio pipeline",ownerTeam:"Cove",environment:"production",scopes:bootstrapScopes};
    }
    await recordPrivilegedAccess(db,request,{actorType:"service",actorId:prefix,permissionOrScope:scope,outcome:"denied",status:401,metadata:{reason:"credential_not_found"}});
    throw new ApiError(401,"The Cove service credential is invalid or revoked.");
  }
  const at=now();
  if(String(credential.principal_status)!=="active"||String(credential.status)!=="active"||(credential.not_before&&String(credential.not_before)>at)||(credential.expires_at&&String(credential.expires_at)<=at)){
    await recordPrivilegedAccess(db,request,{actorType:"service",actorId:String(credential.principal_id),permissionOrScope:scope,outcome:"denied",status:403,metadata:{reason:"credential_inactive"}});throw new ApiError(403,"This Cove service credential is not active.");
  }
  const rows=(await db.prepare("SELECT scope FROM service_principal_scopes WHERE principal_id=?").bind(credential.principal_id).all<any>()).results,scopes=new Set(rows.map((r)=>String(r.scope)));
  if(!scopes.has(scope)&&!scopes.has("*")){await recordPrivilegedAccess(db,request,{actorType:"service",actorId:String(credential.principal_id),permissionOrScope:scope,outcome:"denied",status:403,metadata:{reason:"scope_missing"}});throw new ApiError(403,`Service scope required: ${scope}.`);}
  await db.prepare("UPDATE service_principal_credentials SET last_used_at=?,last_used_country=? WHERE id=?").bind(at,(request.headers.get("cf-ipcountry")||"").slice(0,2)||null,credential.id).run();
  await recordPrivilegedAccess(db,request,{actorType:"service",actorId:String(credential.principal_id),permissionOrScope:scope,outcome:"authorized",status:200,metadata:{credentialId:credential.id}});
  return{principalId:String(credential.principal_id),credentialId:String(credential.id),name:String(credential.name),ownerTeam:String(credential.owner_team),environment:String(credential.environment),scopes};
}

export async function issueServiceCredential(db:AccessDB,actorUserId:string,raw:unknown){
  const x=z.object({principalId:z.string().min(1).max(160),expiresAt:z.string().datetime().nullable().optional(),notBefore:z.string().datetime().nullable().optional()}).parse(raw),p=await db.prepare("SELECT * FROM service_principals WHERE id=? AND status='active'").bind(x.principalId).first<any>();if(!p)throw new ApiError(404,"Active service principal not found.");
  const at=now(),notBefore=x.notBefore||null,defaultExpiry=new Date(Date.now()+90*86400000).toISOString(),expiresAt=x.expiresAt||defaultExpiry;
  if(Date.parse(expiresAt)<=Date.now())throw new ApiError(400,"Service credentials must expire in the future.");
  if(Date.parse(expiresAt)-Date.now()>366*86400000)throw new ApiError(400,"Production service credentials cannot be issued for more than one year. Rotate them instead.");
  if(notBefore&&Date.parse(notBefore)>=Date.parse(expiresAt))throw new ApiError(400,"Credential not-before must precede expiration.");
  const id=`svccred_${crypto.randomUUID()}`,short=crypto.randomUUID().replace(/-/g,"").slice(0,12),secret=base64url(crypto.getRandomValues(new Uint8Array(32))),prefix=`fore_svc_${short}`,token=`${prefix}.${secret}`;
  await db.prepare("INSERT INTO service_principal_credentials(id,principal_id,token_prefix,token_sha256,status,not_before,expires_at,created_by_user_id,created_at) VALUES(?,?,?,?,'active',?,?,?,?)")
    .bind(id,x.principalId,prefix,await sha256(token),notBefore,expiresAt,actorUserId,at).run();
  return{id,principalId:x.principalId,token,tokenPrefix:prefix,expiresAt,warning:"This plaintext service token is shown once. Store it in the deployment secret manager; Cove stores only its SHA-256 digest. Rotate before expiration."};
}

export async function revokeServiceCredential(db:AccessDB,actorUserId:string,raw:unknown){const x=z.object({credentialId:z.string().min(1)}).parse(raw),at=now();const row=await db.prepare("UPDATE service_principal_credentials SET status='revoked',revoked_at=?,revoked_by_user_id=? WHERE id=? AND status='active' RETURNING id,principal_id").bind(at,actorUserId,x.credentialId).first<any>();if(!row)throw new ApiError(404,"Active service credential not found.");return{revoked:true,id:row.id,principalId:row.principal_id};}

export async function saveServicePrincipal(db:AccessDB,actorUserId:string,raw:unknown){const x=z.object({id:z.string().regex(/^svc_[a-z0-9_-]{3,80}$/),name:z.string().min(3).max(120),description:z.string().max(500).default(""),ownerTeam:z.string().min(2).max(100),environment:z.enum(["development","staging","production"]).default("production"),status:z.enum(["active","suspended","retired"]).default("active"),scopes:z.array(z.string().regex(/^[a-z0-9.*:_-]{2,120}$/)).min(1).max(100)}).parse(raw),at=now();
  const existing=await db.prepare("SELECT id FROM service_principals WHERE id=?").bind(x.id).first<any>();const statements:any[]=[db.prepare(`INSERT INTO service_principals(id,name,description,owner_team,environment,status,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,owner_team=excluded.owner_team,environment=excluded.environment,status=excluded.status,updated_at=excluded.updated_at`).bind(x.id,x.name,x.description,x.ownerTeam,x.environment,x.status,actorUserId,at,at),db.prepare("DELETE FROM service_principal_scopes WHERE principal_id=?").bind(x.id)];for(const scope of new Set(x.scopes))statements.push(db.prepare("INSERT INTO service_principal_scopes(principal_id,scope,granted_by_user_id,granted_at) VALUES(?,?,?,?)").bind(x.id,scope,actorUserId,at));await db.batch(statements);return{id:x.id,saved:true,created:!existing};}

export async function servicePrincipalSnapshot(db:AccessDB){const [principals,scopes,credentials,audit]=await Promise.all([db.prepare("SELECT * FROM service_principals ORDER BY owner_team,name").all<any>(),db.prepare("SELECT * FROM service_principal_scopes ORDER BY principal_id,scope").all<any>(),db.prepare("SELECT id,principal_id,token_prefix,status,not_before,expires_at,last_used_at,last_used_country,created_by_user_id,created_at,revoked_at,revoked_by_user_id FROM service_principal_credentials ORDER BY created_at DESC LIMIT 500").all<any>(),db.prepare("SELECT * FROM privileged_access_audit ORDER BY created_at DESC LIMIT 500").all<any>()]);return{principals:principals.results,scopes:scopes.results,credentials:credentials.results,audit:audit.results};}
