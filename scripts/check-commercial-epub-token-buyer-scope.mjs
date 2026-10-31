/* eslint-disable prettier/prettier -- Exercise compiled production protected EPUB bearer-token path with an adversarial D1 fixture. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const source=readFileSync("src/features/fore/delivery.server.ts","utf8");
const pathStart=source.indexOf("export async function serveCommercialEpubGrant(");
const pathEnd=source.indexOf("export async function revokeDeliveryGrant(",pathStart);
assert.ok(pathStart>0&&pathEnd>pathStart);
const route=source.slice(pathStart,pathEnd);
const binding=route.indexOf('"entitlement_scope_mismatch"');
assert.ok(binding>route.indexOf("SELECT * FROM entitlements WHERE id=?"));
assert.ok(binding<route.indexOf("requireStagePaidEntitlementAccess"));
assert.ok(binding<route.indexOf("env.BUCKET?.get"),
  "Source must verify buyer and product BEFORE any private EPUB bytes can be retrieved");
assert.match(route,/String\(ent\.user_id\) !== String\(grant\.user_id\)/);
assert.match(route,/String\(ent\.product_id\) !== String\(grant\.product_id\)/);

const directory=mkdtempSync(join(tmpdir(),"cove-commercial-buyer-scope-"));
try{
  const compiled=join(directory,"delivery.mjs");
  await build({stdin:{contents:`export {serveCommercialEpubGrant} from "./src/features/fore/delivery.server.ts";
export {bindPublicationOwner} from "./src/storefront-strangler/publication-owner-routing.server.ts";`,resolveDir:process.cwd(),sourcefile:"qa-paid-epub-owner.ts",loader:"ts"},outfile:compiled,
    bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {serveCommercialEpubGrant,bindPublicationOwner}=await import(pathToFileURL(compiled).href);
  const token="A".repeat(64),userId="buyer_epub_identity_01",productId="prd_epub_identity_01",entId="ent_epub_identity_01";
  const request=new Request("https://cove.test/api/fore/delivery/epub/"+token,{
    headers:{"cf-ipcountry":"US"}
  });
  async function attempt(overrides={},withSyntheticOwner=false){
    const audits=[],calls={storage:0,owner:0,media:0};
    const ent={id:entId,user_id:userId,product_id:productId,status:"active",
      entitlement_type:"purchase",order_item_id:null,starts_at:null,ends_at:null,
      ...overrides};
    const grant={id:"grant_epub_identity_01",user_id:userId,product_id:productId,
      entitlement_id:entId,status:"active",expires_at:new Date(Date.now()+60000).toISOString(),
      uses:0,max_uses:2,purpose:"read",device_id:null,
      asset_version_id:"asset_identity_01",publication_version_id:null,
      policy_snapshot_json:"{}"};
    const db={prepare(sql){
      return {bind(...args){return {
        async first(){
          if(sql.includes("SELECT * FROM commercial_delivery_grants WHERE token_hash=?"))return grant;
          if(sql==="SELECT * FROM entitlements WHERE id=?"){assert.deepEqual(args,[entId]);return ent;}
          if(sql.includes("entitlement_ownership_records"))return null;
          if(sql.includes("FROM asset_versions av JOIN digital_assets da"))return {
            object_key:"private/buyer-scoped.epub",mime_type:"application/epub+zip",
            size_bytes:6,version_number:1};
          throw Error("Unexpected protected DB read: "+sql);
        },
        async run(){
          if(sql.startsWith("INSERT INTO commercial_download_audit")){
            audits.push({eventType:args[8],reasonCode:args[12]});return {meta:{changes:1}};
          }
          if(sql.startsWith("UPDATE commercial_delivery_grants SET uses=uses+1"))
            return {meta:{changes:1}};
          throw Error("Unexpected protected DB mutation: "+sql);
        }
      }}};
    }};
    const env={DB:db,FORE_DEFAULT_TERRITORY:"US",BUCKET:{async get(){
      calls.storage++;return {body:new Uint8Array([69,80,85,66,49,50]),size:6};
    }}};
    if(withSyntheticOwner){
      const secret="b".repeat(64);
      env.DB=bindPublicationOwner(db,{secret,territory:"US",currency:"USD",owner:{
        async fetch(ownerRequest){
          calls.owner++;
          assert.equal(new URL(ownerRequest.url).pathname,"/delivery/private-consume-epub-grant");
          assert.equal(ownerRequest.headers.get("authorization"),"Bearer "+secret);
          const body=await ownerRequest.json();
          assert.equal(body.grantId,grant.id);
          assert.match(body.tokenHash,/^[a-f0-9]{64}$/);
          assert.equal(body.territory,"US");
          assert.equal(body.channel,"retail");
          return Response.json({schema:"cove.owner-epub-consumption.v1",ownerFirst:true,
            grantId:grant.id,consumed:true,uses:1});
        }
      }});
    }
    const result=await serveCommercialEpubGrant(env,token,request)
      .then(response=>({response}),error=>({error}));
    return {result,audits,calls};
  }
  for(const [label,override] of [
    ["wrong buyer",{user_id:"different_buyer_01"}],
    ["wrong product",{product_id:"prd_different_book_01"}],
    ["wrong buyer and product",{user_id:"different_buyer_01",product_id:"prd_different_book_01"}]
  ]){
    const {result,audits,calls}=await attempt(override);
    assert.equal(result.error?.status,403,label+" must fail as unauthorized");
    assert.equal(calls.storage,0,"No private R2 bytes may be fetched on "+label);
    assert.deepEqual(audits,[{eventType:"denied",reasonCode:"entitlement_scope_mismatch"}],
      "Denied delivery must be audited with a specific reason");
  }
  const revoked=await attempt({status:"revoked"});
  assert.equal(revoked.result.error?.status,403);
  assert.equal(revoked.calls.storage,0);
  const unbound=await attempt();
  assert.equal(unbound.result.error?.status,503,"A matching paid bearer token must never bypass private owner");
  assert.equal(unbound.calls.storage,1,"Original delivery route may load bytes before owner response, but must not return them");
  assert.deepEqual(unbound.audits,[],"Unbound owner must never emit success stream audit");
  const success=await attempt({},true);
  assert.ok(success.result.response instanceof Response,"Same-buyer active entitlement must deliver only after exact private owner acknowledgement");
  assert.equal(success.calls.owner,1,"Real receipt must be verified exactly once");
  assert.equal(success.result.response.status,200);
  assert.equal(success.calls.storage,1);
  assert.deepEqual(success.audits,[{eventType:"stream_started",reasonCode:""}]);
  assert.equal(success.result.response.headers.get("cache-control"),"private, no-store");
  console.log("PASS: production EPUB redemption refuses active entitlements for another buyer/product before R2; same buyer succeeds and revocation denies");
}finally{rmSync(directory,{recursive:true,force:true});}
