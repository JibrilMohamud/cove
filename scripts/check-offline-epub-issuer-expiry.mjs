/* eslint-disable prettier/prettier -- Exercise actual receipt signing; mock only the previously tested delivery grant boundary. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const directory=mkdtempSync(join(tmpdir(),"cove-offline-issuer-"));
try {
  const outfile=join(directory,"issuer.mjs");
  await build({entryPoints:["src/features/fore/offline-epub.server.ts"],outfile,
    bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent",
    plugins:[{name:"issued-delivery-grant",setup(b){
      b.onResolve({filter:/^\.\/delivery\.server$/},()=>({path:"delivery",namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:
        'export async function issueCommercialEpubGrant(){return {grantId:"grant_expiry_test",assetVersionId:"asset_expiry_test",url:"/protected-test"}}'}));
    }}]});
  const {issueOfflineEpubLicense}=await import(pathToFileURL(outfile).href);
  const pair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  let entitlement={status:"active",starts_at:null,ends_at:null};
  const userId="buyer_expiry_test",productId="prd_expiry_test",deviceKey="device-expiry-test-20261028";
  const env={
    FORE_OFFLINE_AUDIO_SIGNING_JWK:JSON.stringify(await crypto.subtle.exportKey("jwk",pair.privateKey)),
    DB:{prepare(sql){
      return {bind(...args){
        return {async first(){
          if(sql.includes("FROM devices"))return {id:"device_expiry_test"};
          if(sql.includes("FROM asset_versions"))return {drm_status:"none"};
          assert.match(sql,/commercial_delivery_grants g JOIN entitlements e/);
          assert.deepEqual(args,["grant_expiry_test",userId,productId]);
          return entitlement;
        }};
      }};
    }}
  };
  const issue=()=>issueOfflineEpubLicense(env,userId,{productId,deviceKey},new Request("https://cove.test"));
  const receipt=await issue();
  const claims=JSON.parse(Buffer.from(receipt.receipt.payload,"base64url").toString("utf8"));
  assert.equal(Date.parse(claims.expiresAt)-Date.parse(claims.issuedAt),7*86400000);
  assert.equal(await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},pair.publicKey,
    Buffer.from(receipt.receipt.signature,"base64url"),
    new TextEncoder().encode("cove-offline-epub:v1\n"+receipt.receipt.payload)),true);
  entitlement.ends_at=new Date(Date.now()+60_000).toISOString();
  assert.equal((await issue()).expiresAt,entitlement.ends_at,
    "Offline receipt must not extend a shorter entitlement to seven days");
  for(const invalid of [
    null,{status:"revoked",starts_at:null,ends_at:null},
    {status:"active",starts_at:"invalid",ends_at:null},
    {status:"active",starts_at:null,ends_at:"invalid"},
    {status:"active",starts_at:new Date(Date.now()+60_000).toISOString(),ends_at:null},
    {status:"active",starts_at:null,ends_at:new Date(Date.now()-60_000).toISOString()}
  ]) {
    entitlement=invalid;
    await assert.rejects(issue(),e=>e.status===403,"Invalid entitlement must never produce a signed receipt");
  }
  console.log("PASS: actual offline EPUB issuer signs seven-day or shorter entitlement-bound receipts and denies revoked, future, expired and invalid scopes");
} finally {rmSync(directory,{recursive:true,force:true});}
