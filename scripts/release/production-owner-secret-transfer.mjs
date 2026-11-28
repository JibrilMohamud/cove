// One-time configuration transfer. No secret values leave Cloudflare's runtime.
export const TRANSFER_ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
export const TRANSFER_OWNER = "cove-legal-authority-production";
export const TRANSFER_BACKEND = "cove-persistence-backend";
export const TRANSFER_OWNER_ID = "6e9c789f211145b0a01cae2dce20745d";
export const TRANSFER_VERIFIER = "cove-production-owner-verifier";
export const TRANSFER_NAMES = Object.freeze([
  "COVE_SOUNDS_SNAPSHOT_ENABLED",
  "FORE_BACKEND_TOKEN_SHA256",
  "FORE_INGESTION_SIGNING_KEY",
  "FORE_OFFLINE_AUDIO_SIGNING_JWK",
  "STRIPE_WEBHOOK_SECRET",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
]);
const encoder = new TextEncoder();
const assert = (ok, reason) => {
  if (!ok) throw Error(reason);
};
export function transferRuntimeModules(originalMain) {
  assert(/^[A-Za-z0-9_./-]+\.m?js$/.test(originalMain), "transfer_main_name");
  const shared = `
const names=${JSON.stringify([...TRANSFER_NAMES, "COVE_RIGHTS_OWNER_SECRET"])};
const enc=new TextEncoder();
const hash=x=>crypto.subtle.digest("SHA-256",enc.encode(x));
async function same(a,b){const [x,y]=await Promise.all([hash(a),hash(b)]);return crypto.subtle.timingSafeEqual(x,y);}
async function admitted(env,nonce){
 const end=Number(env.COVE_TRANSFER_EXPIRES);
 if(env.FORE_ENVIRONMENT!=="production"||!/^[a-f0-9]{64}$/.test(nonce||"")||
 !/^[a-f0-9]{64}$/.test(env.COVE_TRANSFER_NONCE||"")||!Number.isSafeInteger(end)||
 end<=Date.now()||end>Date.now()+600000||!await same(nonce,env.COVE_TRANSFER_NONCE))throw Error("transfer_admission");
}
async function proof(env,keys=names){
 const pairs=keys.map(n=>{const v=env[n];if(typeof v!=="string"||v.length<1||v.length>16384)throw Error("transfer_configuration_missing");return [n,v];});
 const key=await crypto.subtle.importKey("raw",enc.encode(env.COVE_TRANSFER_NONCE),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return [...new Uint8Array(await crypto.subtle.sign("HMAC",key,enc.encode(JSON.stringify(pairs))))].map(x=>x.toString(16).padStart(2,"0")).join("");
}
`;
  const reexports = `export * from ${JSON.stringify("./" + originalMain)};\nexport {default} from ${JSON.stringify("./" + originalMain)};\n`;
  const prefix = 'import {WorkerEntrypoint} from "cloudflare:workers";\n' + reexports + shared;
  const sender =
    prefix +
    `
export class CoveBackendBindingTransfer extends WorkerEntrypoint {
 async inspect(nonce){await admitted(this.env,nonce);return {digest:await proof(this.env)};}
 async existing(nonce){await admitted(this.env,nonce);return {digest:await proof(this.env,["COVE_RIGHTS_OWNER_SECRET"])};}
 async transfer(nonce){
  await admitted(this.env,nonce);
  const expected=await proof(this.env);
  if(typeof this.env.COVE_TRANSFER_TOKEN!=="string"||this.env.COVE_TRANSFER_TOKEN.length<20)throw Error("transfer_credential_missing");
  const secrets=Object.fromEntries(names.slice(0,-1).map(name=>[name,{name,type:"secret_text",text:this.env[name]}]));
  const response=await fetch(${JSON.stringify("https://api.cloudflare.com/client/v4/accounts/" + TRANSFER_ACCOUNT + "/workers/scripts/" + TRANSFER_OWNER + "/secrets-bulk")},{method:"PATCH",headers:{authorization:"Bearer "+this.env.COVE_TRANSFER_TOKEN,"content-type":"application/merge-patch+json"},body:JSON.stringify({secrets}),redirect:"manual",signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error("transfer_provider_rejected");
  const result=await response.json();if(result.success!==true)throw Error("transfer_provider_rejected");
  return {digest:expected};
 }
}
`;
  const receiver =
    prefix +
    `
export class CoveOwnerBindingProof extends WorkerEntrypoint {
 async existing(nonce){await admitted(this.env,nonce);return {digest:await proof(this.env,["COVE_RIGHTS_OWNER_SECRET"])};}
 async verify(nonce){await admitted(this.env,nonce);return {digest:await proof(this.env)};}
}
`;
  const verifier = `export default {async fetch(request,env){
 if(request.method!=="POST"||new URL(request.url).pathname!=="/transfer"||new URL(request.url).search||request.headers.has("cookie")||request.headers.get("content-length")!=="0")return new Response(null,{status:404});
 const nonce=(request.headers.get("authorization")||"").replace(/^Bearer /,"");
 const enc=new TextEncoder(),hash=x=>crypto.subtle.digest("SHA-256",enc.encode(x));
 const [a,b]=await Promise.all([hash(nonce),hash(env.COVE_TRANSFER_NONCE||"")]);
 const end=Number(env.COVE_TRANSFER_EXPIRES);
 if(!crypto.subtle.timingSafeEqual(a,b)||!Number.isSafeInteger(end)||end<=Date.now()||end>Date.now()+600000)return new Response(null,{status:401});
 try{
 const match=async(a,b)=>{const [x,y]=await Promise.all([hash(a),hash(b)]);return crypto.subtle.timingSafeEqual(x,y);};
 const [oldBackend,oldOwner]=await Promise.all([env.BACKEND.existing(nonce),env.OWNER.existing(nonce)]);
 if(!await match(oldBackend.digest,oldOwner.digest))return Response.json({matching:false},{status:409});
 const sent=await env.BACKEND.inspect(nonce);
 let received;try{received=await env.OWNER.verify(nonce);}catch{}
 if(!received||!await match(sent.digest,received.digest)){
   await env.BACKEND.transfer(nonce);
   received=await env.OWNER.verify(nonce);
 }
 if(!await match(sent.digest,received.digest))throw Error("mismatch");
 return Response.json({matching:true,copied:${JSON.stringify(TRANSFER_NAMES)},existingOwnerSecretMatched:true},{headers:{"cache-control":"no-store"}});
 }catch{return Response.json({matching:false},{status:503,headers:{"cache-control":"no-store"}});}
}};`;
  return { sender, receiver, verifier };
}

export function transferVersion(
  original,
  main,
  extra = [],
  modules = [],
  inheritFrom = original.id,
) {
  assert(
    /^[a-f0-9-]{36}$/.test(original.id || "") && /^[a-f0-9-]{36}$/.test(inheritFrom || ""),
    "transfer_exact_version_required",
  );
  assert(
    Array.isArray(original.bindings) && original.bindings.length > 0,
    "transfer_settings_missing",
  );
  assert(
    !original.bindings.some((b) => b.name.startsWith("COVE_TRANSFER_")),
    "transfer_already_active",
  );
  const bindings = original.bindings.map((b) => ({
    name: b.name,
    type: "inherit",
    version_id: inheritFrom,
  }));
  assert(
    new Set([...bindings, ...extra].map((b) => b.name)).size === bindings.length + extra.length,
    "transfer_duplicate_binding",
  );
  const allModules = [...original.modules, ...modules];
  assert(
    allModules.some((m) => m.name === main) &&
      new Set(allModules.map((m) => m.name)).size === allModules.length,
    "transfer_modules",
  );
  const result = { main_module: main, modules: allModules, bindings: [...bindings, ...extra] };
  for (const k of [
    "compatibility_date",
    "compatibility_flags",
    "limits",
    "placement",
    "usage_model",
    "assets",
    "containers",
    "cache_options",
  ])
    if (original[k] !== undefined) result[k] = original[k];
  return result;
}
export function assertOriginalModules(original, actual, wrapperName) {
  assert(actual.main_module === wrapperName, "transfer_main_drift");
  for (const module of original.modules) {
    const next = actual.modules.find((m) => m.name === module.name);
    assert(next && next.content_type === module.content_type, "transfer_module_missing");
    // The provider reconstructs source maps on reads; runtime bytes are exact.
    if (module.content_type !== "application/source-map")
      assert(next.content_base64 === module.content_base64, "transfer_module_drift");
  }
}
export function codeModule(name, code) {
  const bytes = encoder.encode(code);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 16384)
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return { name, content_type: "application/javascript+module", content_base64: btoa(binary) };
}
