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
  const entitlementId="ent_expiry_test";
  let entitlement={id:entitlementId,entitlement_type:"purchase",status:"active",starts_at:null,ends_at:null};
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

  // Emulate refund AFTER a delivery grant returns but BEFORE signing.
  // Canonical D1 active rows must never overrule the owner.
  entitlement={id:entitlementId,entitlement_type:"purchase",status:"active",starts_at:null,ends_at:null};
  env.COVE_SSR_STAGING="1";
  env.COVE_CANONICAL_LEGAL_WRITE_LOCK="1";
  env.COVE_LEGAL_CONSUMER_STAGE_ENABLED="1";
  env.COVE_LEGAL_WRITER_PRIMARY_ID="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
  env.COVE_RIGHTS_OWNER_SECRET="a".repeat(64);
  env.FORE_DEFAULT_TERRITORY="US";
  let mode="allow",ownerRequests=0;
  env.LEGAL_AUTHORITY={getByName(name){
    assert.equal(name,"cove-staged-legal-global-v1");
    return {async fetch(req){
      ownerRequests++;
      assert.equal(req.method,"POST");
      assert.equal(new URL(req.url).pathname,"/commercial/entitlement/authorize");
      assert.equal(req.headers.get("authorization"),"Bearer "+"a".repeat(64));
      const scope=await req.json();
      assert.deepEqual(scope,{entitlementId,userId,productId,territory:"US",channel:"retail"});
      if(mode==="outage")return new Response(null,{status:503});
      if(mode==="refund")return Response.json({schema:"cove.paid-access.v1",allowed:false});
      const proof={
        entitlement_id:entitlementId,user_id:userId,product_id:productId,
        territory:"US",channel:"retail",order_id:"order_expiry_test",
        edition_id:"ed_expiry_test",grant_id:"grant_rights_expiry_test",
        contract_id:"contract_expiry_test",contract_version_id:"contract_v_expiry_test",
        product_epoch:1,entitlement_epoch:2,
        valid_until:new Date(Date.now()+60_000).toISOString()
      };
      if(mode==="mismatch")proof.user_id="other_expiry_buyer";
      return Response.json({schema:"cove.paid-access.v1",allowed:true,proof});
    }};
  }};
  mode="allow";
  assert.ok((await issue()).receipt.signature,"A valid final owner recheck still signs");
  mode="refund";
  await assert.rejects(issue(),e=>e.status===451,
    "Refund after delivery-grant creation must prohibit a new offline receipt");
  mode="outage";
  await assert.rejects(issue(),e=>e.status===503,
    "Owner outage before receipt signing must fail closed");
  mode="mismatch";
  await assert.rejects(issue(),e=>e.status===503,
    "An owner proof for another buyer must not issue an offline receipt");
  assert.equal(ownerRequests,4,"Every attempt requires a fresh final owner authorization");
  console.log("PASS: real offline EPUB signer honors seven-day/entitlement expiry and fails closed on final owner refund, outage or mismatched buyer proof");
} finally {rmSync(directory,{recursive:true,force:true});}
