/* eslint-disable prettier/prettier -- Streaming/audio fixture integration checks. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"cove-soundtrack-external-"));
try {
  fs.cpSync("drizzle",path.join(root,"drizzle"),{recursive:true});
  await build({entryPoints:["src/features/fore/soundtracks.server.ts"],bundle:true,
    platform:"node",format:"esm",outfile:path.join(root,"external.mjs"),logLevel:"silent"});
  const lib=await import(path.join(root,"external.mjs"));
  const env=localBindings(root);
  const sample=Buffer.from("synthetic test bytes, never commercial audio");
  const sha1=createHash("sha1").update(sample).digest("hex"),
        sha256=createHash("sha256").update(sample).digest("hex"),
        now=new Date().toISOString(), token="fore_svc_externalfixture.secret";
  const digest=createHash("sha256").update(token).digest("hex");
  await env.DB.prepare("INSERT INTO service_principals(id,name,owner_team,created_at,updated_at) VALUES('fixture-external','Fixture reviewer','Test',?,?)").bind(now,now).run();
  await env.DB.prepare("INSERT INTO service_principal_scopes(principal_id,scope,granted_at) VALUES('fixture-external','soundtracks.review',?)").bind(now).run();
  await env.DB.prepare("INSERT INTO service_principal_credentials(id,principal_id,token_prefix,token_sha256,created_at) VALUES('fixture-ext-cred','fixture-external','fore_svc_externalfixture',?,?)").bind(digest,now).run();
  await env.DB.prepare("INSERT INTO staff_principals(user_id,email,display_name,status,mfa_required,created_at,updated_at) VALUES('external_staff','staff@example.invalid','External QA','active',1,?,?)").bind(now,now).run();
  await env.DB.prepare("INSERT INTO staff_principal_roles(user_id,role_id,granted_at) VALUES('external_staff','role_soundtrack_reviewer',?)").bind(now).run();
  const staff={id:"external_staff",email:"staff@example.invalid",name:"External QA",
    registered:true,aal:"aal2",authProvider:"supabase",authSubject:"external_staff"};
  const basis={basis:"A signed rights-holder document identifies the exact original recording and authorizes commercial use.",
    evidenceUrls:["https://freemusicarchive.org/music/Artist/Album/Track/"]};
  const quality={sourceSha1:sha1,sha256,bytes:sample.length,durationSeconds:120,channels:2,
    sampleRate:44100,integratedLufs:-20,truePeakDbfs:-1,silenceRatio:.01,clippedSampleRatio:0,
    decodedFully:true,tool:"Fixture FFmpeg evidence",measuredAt:now};
  const manifest={
    provider:"fma",sourcePageUrl:"https://freemusicarchive.org/music/Artist/Album/Track/",
    title:"Fixture Calm Piano Track",composer:"Example Composer",performer:"Example Pianist",
    attributionText:"Example Pianist — Fixture Calm Piano Track (test only), CC BY 4.0",
    licenseCode:"CC-BY",licenseUrl:"https://creativecommons.org/licenses/by/4.0/",
    licenseStatement:"CC BY 4.0",
    providerAccessGrant:{grantingParty:"Example copyright holder",
      scope:"Commercial downloading, copying and redistribution is explicitly authorized by the named master owner.",
      evidenceUrl:"https://example.org/licensing/track-1"},
    rightsEvidence:{composition:basis,arrangement:basis,lyrics:basis,performance:basis,master:basis},
    compositionRightsConfirmed:true,masterRedistributionConfirmed:true,
    unresolved:[],territories:["US"],sha1,sha256,bytes:sample.length,
    mime:"audio/mpeg",period:"contemporary",instruments:["piano"],moods:["calm"],
    energy:.2,hasVocals:false,quality,
  };
  const route=async(path,method="GET",data=null,staffIdentity=null,territory="US")=>{
    const headers={};
    if (!staffIdentity && path.startsWith("/admin/")) headers.authorization="Bearer "+token;
    let body=undefined;
    if (data!==null) {
      if (data instanceof Uint8Array) {
        body=data;
        headers["content-length"]=String(data.length);
        headers["content-type"]="audio/mpeg";
      } else {
        headers["content-type"]="application/json";
        body=JSON.stringify(data);
      }
    }
    return lib.handleSoundtracks(new Request("https://cove.test/api/fore"+path,
      {method,headers,body}),env,path,territory,staffIdentity);
  };
  const register="/admin/soundtracks/external/register";
  const listing=()=>route("/soundtracks/recordings");
  assert.equal((await (await listing()).json()).count,0,"No staged external items should be public");
  await assert.rejects(()=>route(register,"POST",{...manifest,licenseCode:"CC-BY-NC"}),/QA and five-layer/);
  await assert.rejects(()=>route(register,"POST",{...manifest,quality:{...quality,truePeakDbfs:2}}),/QA and five-layer/);
  await assert.rejects(()=>route(register,"POST",{...manifest,sourcePageUrl:"http://localhost/internal"}),/QA and five-layer/);
  const registered=await route(register,"POST",manifest);
  assert.equal(registered.status,201);
  const {id,provenanceSha256}=await registered.json();
  assert.match(id,/^ex_[a-f0-9-]{36}$/);
  const second=await (await route(register,"POST",manifest)).json();
  assert.equal(second.id,id,"Same source hash, page and rights grant must safely reuse pending submission");
  assert.equal((await (await listing()).json()).count,0,"registered originals are still private");
  const file="/admin/soundtracks/external/"+id+"/audio";
  await assert.rejects(()=>route(file,"PUT",new TextEncoder().encode("bad")),/original byte count/i);
  const put=await route(file,"PUT",sample);
  assert.equal((await put.json()).status,"staged");
  await assert.rejects(()=>route(file,"GET"),/Staff MFA required/i,
    "A service delivery token may not stream unpublished master recordings");
  const retryPut=await route(file,"PUT",sample);
  assert.equal((await retryPut.json()).reused,true,
    "Retrying a previously staged original must never replace its bytes");
  const stagedPreview=await route(file,"GET",null,staff);
  assert.equal(stagedPreview.status,200,"authenticated human staff can listen to private staged master");
  assert.equal(await stagedPreview.text(),sample.toString());
  assert.equal((await (await listing()).json()).count,0,"staff preview never makes a staged recording public");
  const approval="/admin/soundtracks/external/"+id+"/approve";
  const reviewerInput={provenanceSha256,assessment:"This is a synthetic reviewed fixture validating original audio identity, provider permission, composition and master rights under a US-only grant. An actual human review would be required for production.",
    sourceLicenseChecked:true,providerPermissionChecked:true,exactMasterListened:true};
  await assert.rejects(()=>route(approval,"POST",reviewerInput),/human staff reviewer/i);
  await assert.rejects(()=>route(approval,"POST",{...reviewerInput,provenanceSha256:"0".repeat(64)},staff),/evidence changed/i);
  const approved=await route(approval,"POST",reviewerInput,staff);
  assert.equal((await approved.json()).status,"ready");
  assert.equal((await (await listing()).json()).count,1);
  assert.equal((await (await route("/soundtracks/recordings","GET",null,null,"FR")).json()).count,0);
  const audio="/soundtracks/recordings/"+id+"/audio";
  const rangeResponse=await lib.handleSoundtracks(new Request("https://cove.test/api/fore"+audio,
    {headers:{range:"bytes=2-7"}}),env,audio,"US");
  assert.equal(rangeResponse.status,206);
  assert.equal(await rangeResponse.text(),sample.subarray(2,8).toString());
  await assert.rejects(()=>route(audio,"GET",null,null,"FR"),/unavailable/i);
  const deleteOriginal=env.BUCKET.delete;
  env.BUCKET.delete=async()=>{throw Error("Simulated temporary R2 storage outage");};
  const revoke=await route("/admin/soundtracks/external/"+id+"/revoke","POST",
    {reason:"Test fixture checks immediate withdrawal of the public streaming entitlement."});
  assert.equal((await revoke.json()).status,"revoked");
  assert.equal((await (await listing()).json()).count,0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_cleanup_queue WHERE recording_id=?").bind(id).first()).n,1,
    "A failed R2 deletion must enqueue durable cleanup even though public playback was immediately removed");
  env.BUCKET.delete=deleteOriginal;
  await lib.importOneReviewedSoundtrack(env);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_cleanup_queue WHERE recording_id=?").bind(id).first()).n,0,
    "Scheduled cleanup must retry the deleted recording");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_external_events WHERE recording_id=?").bind(id).first()).n,4);
  await assert.rejects(()=>env.DB.prepare("DELETE FROM soundtrack_external_events").run(),/append-only/);
  const manuallyAcquired=Buffer.from("Synthetic manually acquired FMA fixture, distinct recording");
  const secondSha1=createHash("sha1").update(manuallyAcquired).digest("hex");
  const secondSha256=createHash("sha256").update(manuallyAcquired).digest("hex");
  const manualManifest={...manifest,
    sourcePageUrl:"https://freemusicarchive.org/music/Artist/Album/Second_Track/",
    title:"Fixture Manually Acquired CC Track",sha1:secondSha1,sha256:secondSha256,
    bytes:manuallyAcquired.length,
    quality:{...quality,sourceSha1:secondSha1,sha256:secondSha256,bytes:manuallyAcquired.length},
    acquisitionEvidence:{method:"manual_download",
      sourcePageUrl:"https://freemusicarchive.org/music/Artist/Album/Second_Track/",
      acquiredAt:now,noAutomatedProviderAccess:true,originalUnmodified:true},
  };
  delete manualManifest.providerAccessGrant;
  const secondRegister=await route(register,"POST",manualManifest);
  assert.equal(secondRegister.status,201,"Commercial CC original needs no redundant provider contract");
  const secondRegistration=await secondRegister.json();
  const manualAudio="/admin/soundtracks/external/"+secondRegistration.id+"/audio";
  await route(manualAudio,"PUT",manuallyAcquired);
  assert.equal((await (await listing()).json()).count,0,"Manual acquisition must not bypass human approval");
  const manualApproval=await route("/admin/soundtracks/external/"+secondRegistration.id+"/approve","POST",
    {...reviewerInput,provenanceSha256:secondRegistration.provenanceSha256},staff);
  assert.equal((await manualApproval.json()).status,"ready");
  assert.equal((await (await listing()).json()).count,1);

  console.log("External provider release tests passed: immutable rights history, QA, R2, playback, staff approval, revocation.");
} finally { fs.rmSync(root,{recursive:true,force:true}); }
