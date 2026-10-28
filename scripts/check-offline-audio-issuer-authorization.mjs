/* eslint-disable prettier/prettier -- Exercise the real audio signer, primary SQLite checks and final private owner RPC. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const directory=mkdtempSync(join(tmpdir(),"cove-audio-final-authorization-"));
const db=new DatabaseSync(":memory:");
try {
  const outfile=join(directory,"issuer.mjs");
  await build({entryPoints:["src/features/fore/offline-audio.server.ts"],outfile,
    bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {signOfflineAudioLicense,verifyStoredAudioLicense}=await import(pathToFileURL(outfile).href);
  const protocolFile=join(directory,"protocol.mjs");
  await build({entryPoints:["src/features/fore/offline-audio-license.ts"],outfile:protocolFile,
    bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {hashText,audioManifestHash,verifyOfflineAudioLicense}=await import(pathToFileURL(protocolFile).href);
  const userId="buyer_audio_final_test",productId="prd_audio_final_test",
    entitlementId="ent_audio_final_test",deviceId="device_audio_final_test",
    deviceKey="device-final-audio-test-20261028",token="token-final-audio-test-".repeat(3);
  db.exec(`CREATE TABLE entitlements(id TEXT PRIMARY KEY,user_id TEXT,product_id TEXT,
    entitlement_type TEXT,status TEXT,starts_at TEXT,ends_at TEXT);
    CREATE TABLE devices(id TEXT PRIMARY KEY,user_id TEXT,device_key TEXT,revoked_at TEXT);
    CREATE TABLE audio_offline_licenses(id TEXT PRIMARY KEY,user_id TEXT,product_id TEXT,
      entitlement_id TEXT,device_id TEXT,token_hash TEXT,manifest_hash TEXT,status TEXT,expires_at TEXT);`);
  db.prepare("INSERT INTO entitlements VALUES(?,?,?,'purchase','active',NULL,NULL)")
    .run(entitlementId,userId,productId);
  db.prepare("INSERT INTO devices VALUES(?,?,?,NULL)").run(deviceId,userId,deviceKey);
  const key=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  let mode="allow",calls=0;
  const env={
    COVE_SSR_STAGING:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_SECRET:"a".repeat(64),
    FORE_OFFLINE_AUDIO_SIGNING_JWK:JSON.stringify(await crypto.subtle.exportKey("jwk",key.privateKey)),
    DB:{prepare(sql){return {bind(...args){return {async first(){
      if(!sql.includes("FROM audio_offline_licenses"))
        assert.deepEqual(args,[entitlementId,userId,productId,deviceId]);
      return db.prepare(sql).get(...args)||null;
    }};}};}},
    LEGAL_AUTHORITY:{getByName(name){
      assert.equal(name,"cove-staged-legal-global-v1");
      return {async fetch(request){
        calls++;
        assert.equal(request.headers.get("authorization"),"Bearer "+env.COVE_RIGHTS_OWNER_SECRET);
        assert.equal(new URL(request.url).pathname,"/commercial/entitlement/authorize");
        assert.deepEqual(await request.json(),{entitlementId,userId,productId,territory:"US",channel:"retail"});
        if(mode==="outage")return new Response(null,{status:503});
        if(mode==="withdrawn")return Response.json({schema:"cove.paid-access.v1",allowed:false});
        const proof={
          entitlement_id:entitlementId,user_id:userId,product_id:productId,
          territory:"US",channel:"retail",order_id:"order_audio_final_test",
          edition_id:"edition_audio_final_test",grant_id:"grant_audio_final_test",
          contract_id:"contract_audio_final_test",contract_version_id:"version_audio_final_test",
          product_epoch:1,entitlement_epoch:1,valid_until:new Date(Date.now()+60_000).toISOString()
        };
        if(mode==="wrong-buyer")proof.user_id="other_audio_buyer";
        return Response.json({schema:"cove.paid-access.v1",allowed:true,proof});
      }};
    }}
  };
  const edition={id:"ca_audio_final_test",productId,
    tracks:[{id:"track_final_test",sha256:"1".repeat(64)}]};
  const input={licenseId:"license_audio_final_test",userId,productId,
    editionId:edition.id,deviceId,deviceKeyHash:await hashText(deviceKey),
    tokenHash:await hashText(token),manifestHash:await audioManifestHash(edition),
    issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*86400000-1000).toISOString()};
  const authorize={entitlementId,territory:"US"};
  const issue=(override={})=>signOfflineAudioLicense(env,{...input,...override},authorize);
  const read=async signed=>verifyOfflineAudioLicense({...signed,licenseId:input.licenseId,
    token,manifestHash:input.manifestHash},signed.verificationKey,{userId,deviceKey,edition});
  const signed=await issue();
  assert.equal((await read(signed)).expiresAt,input.expiresAt);
  const shortened=new Date(Date.now()+60_000).toISOString();
  db.prepare("UPDATE entitlements SET ends_at=?").run(shortened);
  const bounded=await issue();
  assert.equal(bounded.expiresAt,shortened,
    "An entitlement shortened during manifest preparation must bound the signed and returned expiry");
  assert.equal((await read(bounded)).expiresAt,shortened);
  for(const [ownerMode,status] of [["withdrawn",451],["outage",503],["wrong-buyer",503]]) {
    mode=ownerMode;
    await assert.rejects(issue(),error=>error.status===status,
      "Final owner "+ownerMode+" must prevent receipt issuance");
  }
  assert.equal(calls,5,"Every valid signing attempt must obtain a new exact owner proof");
  mode="allow";
  for(const [column,value] of [
    ["status","revoked"],["starts_at","invalid"],["ends_at","invalid"],
    ["starts_at",new Date(Date.now()+60_000).toISOString()],
    ["ends_at",new Date(Date.now()-60_000).toISOString()]
  ]) {
    db.exec("UPDATE entitlements SET status='active',starts_at=NULL,ends_at=NULL");
    db.prepare("UPDATE entitlements SET "+column+"=?").run(value);
    await assert.rejects(issue(),error=>error.status===403,
      "Late canonical "+column+" change must prevent signing");
  }
  db.exec("UPDATE entitlements SET status='active',starts_at=NULL,ends_at=NULL");
  db.exec("UPDATE devices SET revoked_at='2026-10-28T00:00:00Z'");
  await assert.rejects(issue(),error=>error.status===403,"Late device revocation must prevent signing");
  db.exec("UPDATE devices SET revoked_at=NULL,device_key='replacement-device-key'");
  await assert.rejects(issue(),error=>error.status===403,"Replacement device key must not borrow old identity");
  db.prepare("UPDATE devices SET device_key=?").run(deviceKey);
  for(const override of [
    {issuedAt:"invalid"},{expiresAt:"invalid"},
    {issuedAt:new Date(Date.now()+120_000).toISOString()},
    {expiresAt:new Date(Date.now()-60_000).toISOString()},
    {expiresAt:new Date(Date.parse(input.issuedAt)+31*86400000).toISOString()}
  ])await assert.rejects(issue(override),error=>error.status===403);
  await assert.rejects(signOfflineAudioLicense(env,input),error=>error.status===503,
    "Enrolled owner mode cannot sign without an exact purchase identity");
  assert.equal(calls,5,"Invalid primary/device/time scope must not reach owner signing authorization");
  db.prepare("INSERT INTO audio_offline_licenses VALUES(?,?,?,?,?,?,?,'active',?)")
    .run(input.licenseId,userId,productId,entitlementId,deviceId,
      input.tokenHash,input.manifestHash,input.expiresAt);
  const verify=()=>verifyStoredAudioLicense(env,userId,productId,input.licenseId,token,input.manifestHash,"US");
  assert.equal((await verify()).valid,true,"A valid stored exact license still verifies online");
  mode="withdrawn";
  await assert.rejects(verify(),error=>error.status===451,
    "Online verification must deny stale active SQL after owner withdrawal");
  mode="outage";
  await assert.rejects(verify(),error=>error.status===503);
  mode="allow";
  db.exec("UPDATE audio_offline_licenses SET expires_at='zz-not-a-date'");
  await assert.rejects(verify(),error=>error.status===403,
    "Lexically future malformed SQL license dates cannot authorize online verification");
  db.prepare("UPDATE audio_offline_licenses SET expires_at=?").run(input.expiresAt);
  db.exec("UPDATE entitlements SET ends_at='zz-not-a-date'");
  await assert.rejects(verify(),error=>error.status===403,
    "Malformed entitlement expiry cannot pass merely because SQL text compares above today's date");
  console.log("PASS: real audio signer rechecks exact live purchase/device and final owner; expiry changes, refund, outage, proof mismatch and device revocation cannot mint an invalid receipt");
} finally {db.close();rmSync(directory,{recursive:true,force:true});}
