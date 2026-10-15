/* eslint-disable prettier/prettier -- Mock fixture test keeps its example payloads compact. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-soundtracks-"));
const originalFetch = globalThis.fetch;
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/soundtracks.server.ts"],
    bundle: true, platform: "node", format: "esm",
    outfile: path.join(root, "soundtracks.mjs"), logLevel: "silent",
  });
  const lib = await import(path.join(root, "soundtracks.mjs"));
  const env = localBindings(root);
  const music = Buffer.from("synthetic bytes: not a musical recording");
  const sha1 = createHash("sha1").update(music).digest("hex");
  const good = (id, label, license = "CC0", url = "http://creativecommons.org/publicdomain/zero/1.0/deed.en") => ({
    revisions:[{revid:123,timestamp:"2026-01-01T00:00:00Z",slots:{main:{content:"Original creator release (test fixture)"}}}],
    pageid: id, title: "File:" + label + ".ogg",
    imageinfo: [{
      mime: "application/ogg", size: music.length, sha1,
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/" + label + ".ogg?utm_source=commons.wikimedia.org&utm_content=original",
      extmetadata: {
        LicenseShortName: { value: license },
        LicenseUrl: { value: url },
        Artist: { value: "Example pianist" },
      },
    }],
  });
  const pages = [
    good(101,"Nocturne", "CC0"),
    good(102,"Allegro","CC BY 4.0","https://creativecommons.org/licenses/by/4.0/"),
    good(103,"Noncommercial","CC BY-NC 4.0","https://creativecommons.org/licenses/by-nc/4.0/"),
    good(104,"NoRights","unknown",""),
    good(105,"Minuet","CC BY-SA 3.0","https://creativecommons.org/licenses/by-sa/3.0"),
  ];
  let upstreamChanged = false;
  let mediaRequests = 0;
  let mediaStored = 0;
  const originalPut = env.BUCKET.put;
  env.BUCKET.put = async (...args) => {
    mediaStored++;
    if (String(args[0]).startsWith("soundtracks/v1/")) {
      assert.equal(args[2].sha256, createHash("sha256").update(music).digest("hex"), "R2 validates the measured exact-file SHA-256");
    } else mediaStored--;
    return originalPut(...args);
  };
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.startsWith("https://commons.wikimedia.org/w/api.php")) {
      assert.match(options?.headers?.["User-Agent"] || "", /^CoveSoundtracks\//);
      assert.match(options?.headers?.["Api-User-Agent"] || "", /^CoveSoundtracks\//);
      assert.equal(options?.redirect, "manual", "Workers can only use manual redirects");
      const query = new URL(target).searchParams;
      if (query.get("generator")) return Response.json({ query: { pages } });
      const page = pages.find((p) => p.title === query.get("titles"));
      if (!page) throw Error("Bad Commons lookup");
      return Response.json({ query: { pages:[upstreamChanged
        ? { ...page, imageinfo: [{...page.imageinfo[0], sha1: "f".repeat(40)}] }
        : page] } });
    }
    if (target.startsWith("https://upload.wikimedia.org/")) {
      mediaRequests++;
      assert.equal(new URL(target).search, "", "untrusted tracking query is not proxied");
      return new Response(music, {
        headers: {"content-type":"application/ogg","content-length": String(music.length) },
      });
    }
    throw Error("Untrusted destination: " + target);
  };
  const initial = await lib.discoverSoundtrackCandidates(env);
  assert.equal(initial.queuedForRightsReview,3,"CC0, CC BY, and original CC BY-SA may be staged; NC/unknown excluded");
  assert.equal(mediaRequests,0,"candidate discovery never downloads media");
  const publicRequest = new Request("https://cove.test/api/fore/soundtracks/recordings");
  const listing = () => lib.handleSoundtracks(publicRequest,env,"/soundtracks/recordings","US");
  assert.equal((await (await listing()).json()).count,0,"no candidate is public");
  assert.equal((await lib.importOneReviewedSoundtrack(env)).skipped,"no_approved_recordings");
  const row = await env.DB.prepare("SELECT * FROM soundtrack_recordings WHERE id='cm_101'").first();
  assert.equal(row.status,"pending_review");
  assert.equal(row.mime,"audio/ogg","Commons application/ogg must normalize for browser playback");
  assert.equal(row.license_url,"https://creativecommons.org/publicdomain/zero/1.0/");
  assert.ok(!row.source_file_url.includes("?"),"metadata analytics params must not become media URL");
  const shareAlike = await env.DB.prepare("SELECT * FROM soundtrack_recordings WHERE id='cm_105'").first();
  assert.equal(shareAlike.license_code,"CC-BY-SA");
  assert.equal(shareAlike.status,"pending_review");
  // Rotate between periods instead of filling the entire pool with piano pieces.
  await env.DB.prepare("UPDATE soundtrack_ingestion_state SET last_discovery_at='' WHERE id=1").run();
  const next = await lib.discoverSoundtrackCandidates(env);
  assert.match(next.source,/Baroque/);
  assert.equal(next.queuedForRightsReview,0,"duplicate Commons files are not re-inserted");
  assert.equal(row.period,"mixed");
  assert.match(row.moods_json,/reflective/);
  assert.equal(row.energy,0.25);
  assert.match(row.evidence_json,/UNVERIFIED/);
  assert.equal(mediaStored,0);

  const token = "fore_svc_testreview.secret";
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO service_principals(id,name,owner_team,created_at,updated_at) VALUES('test-review','Fixture reviewer','Test',?,?)").bind(at,at).run();
  await env.DB.prepare("INSERT INTO service_principal_scopes(principal_id,scope,granted_at) VALUES('test-review','soundtracks.review',?)").bind(at).run();
  await env.DB.prepare("INSERT INTO service_principal_credentials(id,principal_id,token_prefix,token_sha256,created_at) VALUES('test-cred','test-review','fore_svc_testreview',?,?)").bind(createHash("sha256").update(token).digest("hex"),at).run();
  const staffIdentity = {id:"fixture_staff",email:"staff@example.invalid",name:"Fixture reviewer",registered:true,aal:"aal2",authProvider:"supabase",authSubject:"fixture_staff"};
  await env.DB.prepare("INSERT INTO staff_principals(user_id,email,display_name,status,mfa_required,created_at,updated_at) VALUES('fixture_staff','staff@example.invalid','Fixture reviewer','active',1,?,?)").bind(at,at).run();
  await env.DB.prepare("INSERT INTO staff_principal_roles(user_id,role_id,granted_at) VALUES('fixture_staff','role_soundtrack_reviewer',?)").bind(at).run();
  const staffRequest = new Request("https://cove.test/api/fore/admin/soundtracks");
  await assert.rejects(()=>lib.handleSoundtracks(staffRequest,env,"/admin/soundtracks","US",{...staffIdentity,aal:"aal1"}),/MFA/i);
  assert.equal((await lib.handleSoundtracks(staffRequest,env,"/admin/soundtracks","US",staffIdentity)).status,200,"Dedicated reviewer role works with a verified MFA session");
  await assert.rejects(()=>lib.handleSoundtracks(staffRequest,env,"/admin/soundtracks","US",{...staffIdentity,id:"unassigned"}),/not provisioned/i);
  const adminPath = "/admin/soundtracks/recordings/cm_101";
  const review = async (action, extra = {}, version, id = "cm_101") => {
    const row = await env.DB.prepare("SELECT review_version FROM soundtrack_recordings WHERE id=?").bind(id).first();
    const target = "/admin/soundtracks/recordings/" + id;
    return lib.handleSoundtracks(new Request("https://cove.test/api/fore"+target,{
      method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify({action,version:version ?? row.review_version,...extra}),
    }),env,target,"US");
  };
  const basis = {basis:"Fixture evidence: original composition from a historical published score with an original creator recording release.", evidenceUrls:["https://commons.wikimedia.org/wiki/File:Fixture.ogg"]};
  const dossier = {composition:basis,arrangement:basis,lyrics:basis,performance:basis,master:basis,
    grantingParty:"Example pianist",recordingDate:"2020-01-01",territoryBasis:basis.basis,streamingBasis:basis.basis,
    attributionText:"Example pianist — Nocturne (fixture only)",modificationNotice:"Original source file; no modifications.",
    reviewMethod:"ai_assisted",complexProvenance:false,unresolved:[]};
  const approval = {title:"Reviewed Nocturne",reviewer:"TEST-101",reviewEvidence:basis.basis,performer:"Example pianist",composer:"Example composer",
    territories:["US"],compositionRightsConfirmed:true,performanceRightsConfirmed:true,attributionReviewed:true,
    period:"romantic",instruments:["piano"],moods:["reflective"],energy:0.25,hasVocals:false};
  await assert.rejects(()=>review("approve",approval),/dossier/i,"Missing layer evidence blocks approval");
  await review("draft",{dossier:{...dossier,unresolved:["Master ownership is disputed"]}});
  await assert.rejects(()=>review("approve",approval),/unresolved/i);
  await review("draft",{dossier});
  await assert.rejects(()=>review("approve",approval),/audio QA/i);
  const report = {sourceSha1:sha1,sha256:createHash("sha256").update(music).digest("hex"),bytes:music.length,
    durationSeconds:120,channels:2,sampleRate:44100,integratedLufs:-20,truePeakDbfs:-1,silenceRatio:0.01,
    clippedSampleRatio:0,decodedFully:true,tool:"Fixture measurements only",measuredAt:at};
  await assert.rejects(()=>review("quality",{report:{...report,sourceSha1:"f".repeat(40)}}),/different source/i);
  await review("quality",{report:{...report,truePeakDbfs:2}});
  await assert.rejects(()=>review("approve",approval),/audio QA/i,"Clipping/true-peak failure blocks release");
  await review("quality",{report});
  await review("draft",{dossier:{...dossier,complexProvenance:true}});
  await review("endorse",{reason:basis.basis});
  await assert.rejects(()=>review("approve",approval),/second independent/i,"Self-endorsement cannot satisfy second review");
  await review("draft",{dossier});
  await assert.rejects(()=>review("draft",{dossier},0),/changed/i,"Stale review cannot overwrite another decision");
  const approved = await review("approve",approval);
  assert.equal(approved.status,200);
  const snapshotRow = await env.DB.prepare("SELECT * FROM soundtrack_recordings WHERE id='cm_101'").first();
  assert.ok(snapshotRow.source_snapshot_key);
  assert.equal(snapshotRow.title,"Reviewed Nocturne","Reviewed public title is separate from the immutable source filename");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_rights_decisions WHERE action='approve'").first()).n,1);
  await assert.rejects(()=>env.DB.prepare("UPDATE soundtrack_rights_decisions SET principal_id='forged'").run(),/append-only/);
  await assert.rejects(()=>env.DB.prepare("DELETE FROM soundtrack_review_events").run(),/append-only/);

  // Source drift must invalidate the approval even after the complete review flow.
  const reviewed = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE soundtrack_recordings SET status='approved',reviewed_at=?,reviewed_by='test reviewer',review_evidence='Independent record of composer and performance rights',allowed_territories_json='[\"US\"]' WHERE id='cm_101'",
  ).bind(reviewed).run();
  upstreamChanged = true;
  const invalidated = await lib.importOneReviewedSoundtrack(env);
  assert.equal(invalidated.invalidated,"cm_101","changed source checksum invalidates approval");
  assert.equal(mediaRequests,0,"changed source never downloads");
  assert.equal((await env.DB.prepare("SELECT status FROM soundtrack_recordings WHERE id='cm_101'").first()).status,"pending_review");
  upstreamChanged = false;
  await env.DB.prepare(
    "UPDATE soundtrack_recordings SET status='approved',reviewed_at=?,reviewed_by='test reviewer',review_evidence='Reviewed composition and performance',allowed_territories_json='[\"US\"]' WHERE id='cm_101'",
  ).bind(reviewed).run();
  const importPath = "/admin/soundtracks/import-next";
  const imported = await lib.handleSoundtracks(new Request("https://cove.test/api/fore"+importPath,{
    method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:"{}",
  }),env,importPath,"US");
  const stored = await imported.json();
  assert.equal(stored.stored,"cm_101");
  await assert.rejects(()=>lib.handleSoundtracks(new Request("https://cove.test/api/fore"+importPath,{method:"POST"}),env,importPath,"US"),/credential/i);
  assert.equal(mediaStored,1);
  assert.equal((await (await listing()).json()).count,1);
  const international = await lib.handleSoundtracks(publicRequest,env,"/soundtracks/recordings","FR");
  assert.equal((await international.json()).count,0,"territory restrictions are enforced");
  const audioPath = "/soundtracks/recordings/cm_101/audio";
  const audio = await lib.handleSoundtracks(new Request("https://cove.test/api/fore" + audioPath, {
    headers: { range: "bytes=0-7" },
  }),env,audioPath,"US");
  assert.equal(audio.status,206);
  assert.equal(await audio.text(),music.subarray(0,8).toString());
  assert.equal(audio.headers.get("content-range"),"bytes 0-7/"+music.length);
  const suffix = await lib.handleSoundtracks(new Request("https://cove.test/api/fore"+audioPath,{headers:{range:"bytes=-8"}}),env,audioPath,"US");
  assert.equal(suffix.status,206);
  assert.equal(await suffix.text(),music.subarray(-8).toString(),"Suffix ranges support seeking");
  const clamped = await lib.handleSoundtracks(new Request("https://cove.test/api/fore"+audioPath,{headers:{range:"bytes=0-999999"}}),env,audioPath,"US");
  assert.equal(clamped.status,206);assert.equal(clamped.headers.get("content-length"),String(music.length));
  const unsatisfiable = await lib.handleSoundtracks(new Request("https://cove.test/api/fore"+audioPath,{headers:{range:"bytes=999999-"}}),env,audioPath,"US");
  assert.equal(unsatisfiable.status,416);assert.equal(unsatisfiable.headers.get("content-range"),"bytes */"+music.length);
  const headRequest = await lib.handleSoundtracks(new Request("https://cove.test/api/fore"+audioPath,{method:"HEAD",headers:{range:"bytes=0-7"}}),env,audioPath,"US");
  assert.equal(headRequest.status,200);assert.equal(headRequest.headers.get("content-length"),String(music.length));

  await assert.rejects(() => lib.handleSoundtracks(
    new Request("https://cove.test/api/fore" + audioPath),env,audioPath,"FR"),
  /unavailable/i);
  await assert.rejects(() => lib.handleSoundtracks(
    new Request("https://cove.test/api/fore/admin/soundtracks"),env,"/admin/soundtracks","US"),
  /credential/i,"review endpoints never accept anonymous access");
  const rowBeforeRace = await env.DB.prepare("SELECT review_version FROM soundtrack_recordings WHERE id='cm_101'").first();
  const originalBatch = env.DB.batch;
  env.DB.batch = async statements => {
    env.DB.batch = originalBatch;
    await env.DB.prepare("UPDATE soundtrack_recordings SET review_version=review_version+1 WHERE id='cm_101'").run();
    return originalBatch(statements);
  };
  await assert.rejects(()=>review("revoke",{reason:"Simulated concurrent withdrawal review."},rowBeforeRace.review_version),/concurrent review/i);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_rights_decisions WHERE action='revoke'").first()).n,0,"A failed optimistic update cannot write a successful audit event");
  const originalDelete = env.BUCKET.delete;
  env.BUCKET.delete = async () => { throw new Error("Fixture storage outage"); };
  await review("revoke",{reason:"Fixture rights challenge: withdraw immediately pending investigation."});
  assert.equal((await (await listing()).json()).count,0,"Withdrawal blocks catalog access despite storage outage");
  await assert.rejects(()=>lib.handleSoundtracks(new Request("https://cove.test/api/fore"+audioPath),env,audioPath,"US"),/unavailable/i);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_cleanup_queue").first()).n,1);
  env.BUCKET.delete = originalDelete;
  await lib.importOneReviewedSoundtrack(env);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_cleanup_queue").first()).n,0,"Cleanup is durably retried after withdrawal");
  assert.equal(mediaRequests,1);
  // Repository reliance is explicit, exact-file-bound and auditable. It does not
  // pretend an independent reviewer checked the declaration.
  const sourceRow = await env.DB.prepare("SELECT * FROM soundtrack_recordings WHERE id='cm_105'").first();
  const pdUrl = "https://commons.wikimedia.org/wiki/Commons:Licensing";
  await env.DB.prepare("UPDATE soundtrack_recordings SET license_code='PD',license_url=?,license_statement='Public domain (Commons claim)' WHERE id='cm_105'").bind(pdUrl).run();
  pages[4].imageinfo[0].extmetadata.LicenseShortName.value = "Public domain";
  pages[4].imageinfo[0].extmetadata.LicenseUrl.value = "";
  pages[4].imageinfo[0].extmetadata.Copyrighted = {value:"False"};
  const sourceDossier = {...dossier, reviewMethod:"source_license", sourceReliance:{
    sourcePageUrl:sourceRow.source_page_url,sourceSha1:sha1,licenseCode:"PD",licenseUrl:pdUrl,
    declarationBasis:"Accept the recording-specific repository declaration under Cove's source-reliance policy; no independent human review is represented."}};
  const sourceReview = (action,extra) => review(action,extra,undefined,"cm_105");
  await assert.rejects(()=>sourceReview("draft",{dossier:{...dossier,reviewMethod:"source_license"}}),/source links/i);
  await sourceReview("quality",{report});
  await sourceReview("draft",{dossier:{...sourceDossier,sourceReliance:{...sourceDossier.sourceReliance,sourceSha1:"0".repeat(40)}}});
  await assert.rejects(()=>sourceReview("approve",approval),/exact recording/i);
  await sourceReview("draft",{dossier:{...sourceDossier,unresolved:["Conflicting master ownership"]}});
  await assert.rejects(()=>sourceReview("approve",approval),/unresolved/i);
  await sourceReview("draft",{dossier:{...sourceDossier,complexProvenance:true}});
  await assert.rejects(()=>sourceReview("approve",approval),/second independent/i);
  await sourceReview("draft",{dossier:sourceDossier});
  await assert.rejects(()=>sourceReview("approve",{...approval,territories:["*"]}),/limited to the US/i);
  upstreamChanged = true;
  await assert.rejects(()=>sourceReview("approve",approval),/source or license changed/i);
  upstreamChanged = false;
  assert.equal((await sourceReview("approve",approval)).status,200,"Straightforward repository PD reliance needs no second principal");
  const sourceDecision = await env.DB.prepare("SELECT evidence_json FROM soundtrack_rights_decisions WHERE recording_id='cm_105' AND action='approve'").first();
  assert.equal(JSON.parse(sourceDecision.evidence_json).dossier.reviewMethod,"source_license");
  console.log("Soundtrack discovery, license filters, review gate, source drift, R2 checksum, attribution, territory and streaming passed.");
} finally {
  globalThis.fetch=originalFetch;
  fs.rmSync(root,{recursive:true,force:true});
}
