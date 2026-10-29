/* eslint-disable prettier/prettier -- Verify the exact production protected EPUB asset lookup against real SQLite rows. */
import assert from "node:assert/strict";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";

const source=readFileSync("src/features/fore/delivery.server.ts","utf8");
const begin=source.indexOf("export async function serveCommercialEpubGrant(");
const end=source.indexOf("export async function revokeDeliveryGrant(",begin);
assert.ok(begin>=0&&end>begin);
const route=source.slice(begin,end);
const sql="SELECT av.*,da.downloadable,da.drm_status FROM asset_versions av JOIN digital_assets da ON da.id=av.asset_id JOIN products p ON p.edition_id=da.edition_id WHERE av.id=? AND p.id=? AND da.kind='epub'";
assert.ok(route.includes('"'+sql+'"'),"The exact published SQL must contain edition/format check");
assert.match(route,/\.bind\(grant\.asset_version_id, grant\.product_id\)/);
assert.ok(route.indexOf(sql)<route.indexOf("env.BUCKET?.get"),
  "A private R2 request may not precede the asset-scope check");

const db=new DatabaseSync(":memory:");
const folder=mkdtempSync(join(tmpdir(),"cove-asset-redemption-"));
try {
  db.exec("CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT);"+
    "CREATE TABLE digital_assets(id TEXT PRIMARY KEY,edition_id TEXT,kind TEXT,downloadable INTEGER,drm_status TEXT);"+
    "CREATE TABLE asset_versions(id TEXT PRIMARY KEY,asset_id TEXT,object_key TEXT,mime_type TEXT,size_bytes INTEGER,version_number INTEGER);");
  for(const pair of [["prd_buyer_book","edition_buyer"],["prd_other_book","edition_other"]])
    db.prepare("INSERT INTO products VALUES(?,?)").run(...pair);
  for(const row of [
    ["asset_buyer","edition_buyer","epub",1,"none"],
    ["asset_other","edition_other","epub",1,"none"],
    ["asset_audio","edition_buyer","audio",1,"none"],
  ])db.prepare("INSERT INTO digital_assets VALUES(?,?,?,?,?)").run(...row);
  for(const row of [
    ["version_buyer","asset_buyer","private/book-buyer.epub","application/epub+zip",6,1],
    ["version_other","asset_other","private/book-other.epub","application/epub+zip",6,1],
    ["version_audio","asset_audio","private/other-audio.bin","application/octet-stream",6,1]
  ])db.prepare("INSERT INTO asset_versions VALUES(?,?,?,?,?,?)").run(...row);
  const get=(assetId,productId)=>db.prepare(sql).get(assetId,productId);
  assert.equal(get("version_buyer","prd_buyer_book")?.object_key,"private/book-buyer.epub");
  for(const [assetId,productId] of [
    ["version_other","prd_buyer_book"],
    ["version_buyer","prd_other_book"],
    ["version_audio","prd_buyer_book"],
    ["version_other","prd_missing"],
  ])assert.equal(get(assetId,productId),undefined,
    "An EPUB bearer token may not be exchanged for a foreign or non-EPUB asset");

  const compiled=join(folder,"delivery.mjs");
  await build({entryPoints:["src/features/fore/delivery.server.ts"],outfile:compiled,
    bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {serveCommercialEpubGrant}=await import(pathToFileURL(compiled).href);
  const token="Z".repeat(64),request=new Request("https://cove.test/api/fore/delivery/epub/"+token),
    buyer="buyer_epub_asset_01",product="prd_buyer_book",entId="ent_epub_asset_01";

  async function redeem(versionId){
    const audits=[],calls={r2:0};
    const grant={id:"grant_epub_asset_01",user_id:buyer,product_id:product,
      entitlement_id:entId,asset_version_id:versionId,publication_version_id:null,
      status:"active",issued_at:new Date().toISOString(),
      expires_at:new Date(Date.now()+60000).toISOString(),uses:0,max_uses:2,
      purpose:"read",device_id:null,policy_snapshot_json:"{}"};
    const ent={id:entId,user_id:buyer,product_id:product,status:"active",
      entitlement_type:"purchase",order_item_id:null,starts_at:null,ends_at:null};
    const env={FORE_DEFAULT_TERRITORY:"US",BUCKET:{async get(key){
      calls.r2++;assert.equal(key,"private/book-buyer.epub");
      return {body:new Uint8Array([69,80,85,66,49,50]),size:6};
    }},DB:{prepare(query){
      return {bind(...args){return {
        async first(){
          if(query.includes("SELECT * FROM commercial_delivery_grants WHERE token_hash=?"))return grant;
          if(query==="SELECT * FROM entitlements WHERE id=?")return ent;
          if(query.includes("entitlement_ownership_records"))return null;
          if(query===sql)return db.prepare(sql).get(...args)||null;
          throw Error("Unexpected protected read: "+query);
        },
        async run(){
          if(query.startsWith("INSERT INTO commercial_download_audit")){
            audits.push({event:args[8],reason:args[12]});return {meta:{changes:1}};
          }
          if(query.startsWith("UPDATE commercial_delivery_grants SET uses=uses+1"))
            return {meta:{changes:1}};
          throw Error("Unexpected protected writer: "+query);
        }
      }}};
    }}};
    const result=await serveCommercialEpubGrant(env,token,request)
      .then(response=>({response}),error=>({error}));
    return {result,audits,calls};
  }
  for(const id of ["version_other","version_audio"]){
    const outcome=await redeem(id);
    assert.equal(outcome.result.error?.status,503,
      "A foreign/non-EPUB version may not be delivered");
    assert.equal(outcome.calls.r2,0,"Private R2 is never requested on invalid asset identity");
    assert.deepEqual(outcome.audits,[{event:"denied",reason:"asset_missing"}]);
  }
  const success=await redeem("version_buyer");
  assert.equal(success.result.response?.status,200,"Valid EPUB for purchased edition must still stream");
  assert.equal(success.calls.r2,1);
  assert.equal(success.result.response.headers.get("cache-control"),"private, no-store");
  console.log("PASS: actual commercial EPUB redemption refuses foreign-edition and non-EPUB asset versions before R2, valid purchased EPUB still streams");
} finally{db.close();rmSync(folder,{recursive:true,force:true});}
