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
  const embeddedNC = good(106,"EmbeddedNC","CC0");
  embeddedNC.imageinfo[0].metadata = [{name:"Copyright",value:"Attribution-Noncommercial-Share Alike 3.0 United States: https://creativecommons.org/licenses/by-nc-sa/3.0/us/"}];
  const pages = [
    good(101,"Nocturne", "CC0"),
    good(102,"Allegro","CC BY 4.0","https://creativecommons.org/licenses/by/4.0/"),
    good(103,"Noncommercial","CC BY-NC 4.0","https://creativecommons.org/licenses/by-nc/4.0/"),
    good(104,"NoRights","unknown",""),
    good(105,"Minuet","CC BY-SA 3.0","https://creativecommons.org/licenses/by-sa/3.0"),
    embeddedNC,
  ];
  let upstreamChanged = false;
  let upstreamUnavailable = false;
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
      if (upstreamUnavailable) return new Response("temporarily unavailable",{status:503});
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
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_recordings WHERE id='cm_106'").first()).n,0,
    "An original containing embedded NC is excluded despite a conflicting Commons CC0 label");
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
  // Cumulative discovery over 750 must not block a queue with free space.
  await env.DB.prepare("UPDATE soundtrack_ingestion_state SET discovered=750,last_discovery_at='' WHERE id=1").run();
  const pastLifetimeLimit = await lib.discoverSoundtrackCandidates(env);
  assert.equal(pastLifetimeLimit.queuedForRightsReview,0,"cumulative intake is not a queue cap");
  assert.ok(!pastLifetimeLimit.skipped,"candidate lifetime count cannot stop intake");

  // A week after category exhaustion, restart discovery without duplicating files.
  const categories = [
    "Audio files of classical music for piano",
    "Audio files of Baroque period classical music",
    "Audio files of Classical period classical music",
    "Audio files of Romantic period classical music",
    "Audio files of renaissance period classical music",
    "Audio files of medieval period classical music",
    "Classical music from Free Music Archive",
    "Piano music from Free Music Archive",
    "Contemporary classical music from Free Music Archive",
    "Audio files of music by Johann Sebastian Bach",
    "Audio files of music by Domenico Scarlatti",
    "Audio files of music by Ludwig van Beethoven",
    "Audio files of music by Franz Schubert",
    "Audio files of classical music for violin",
    "Audio files of music by Antonio Vivaldi",
    "Audio files of music by Robert Schumann",
    "Audio files of music by Felix Mendelssohn",
    "Audio files of adagio (music)",
    "Audio files of music by Frédéric Chopin",
    "Audio files of nocturnes by Frédéric Chopin",
    "Audio files of harp music",
    "Audio files of cello music",
    "Audio files of harpsichord music",
    "Audio files of guitar music",
    "Audio files of music by Erik Satie",
    "Audio files of Nocturnes, Op. 9 by Frédéric Chopin",
    "Audio files of piano music by Joseph Haydn",
  ];
  // Commons hosts already-licensed FMA audio; source discovery must never
  // access FMA directly or assume category membership implies approval.
  pages.push(good(107,"FMA Independent Original","CC BY 4.0","https://creativecommons.org/licenses/by/4.0/"));
  const oldCategoryCursors = Object.fromEntries(categories.slice(0,6).map(name=>[name,"DONE"]));
  await env.DB.prepare("UPDATE soundtrack_ingestion_state SET category_cursors_json=?,category_index=0,last_discovery_at='' WHERE id=1")
    .bind(JSON.stringify(oldCategoryCursors)).run();
  const fmaDiscovery = await lib.discoverSoundtrackCandidates(env);
  assert.equal(fmaDiscovery.source,"Classical music from Free Music Archive");
  assert.equal(fmaDiscovery.queuedForRightsReview,1,"Only the newly discovered commercially declared master is queued");
  const fmaRow = await env.DB.prepare("SELECT status,automated_triage_reason,evidence_json FROM soundtrack_recordings WHERE id='cm_107'").first();
  assert.equal(fmaRow.status,"pending_review");
  assert.match(fmaRow.automated_triage_reason,/verify FMA master license/);
  assert.match(fmaRow.evidence_json,/Classical music from Free Music Archive/);
  assert.equal((await (await listing()).json()).count,0,"FMA-origin Commons tracks are never implicitly published");
  assert.equal(mediaRequests,0,"FMA source discovery must never scrape or download provider audio");
  const cursors = Object.fromEntries(categories.map(name=>[name,"DONE"]));
  cursors._cycleFinishedAt = new Date(Date.now()-8*86400_000).toISOString();
  await env.DB.prepare("UPDATE soundtrack_ingestion_state SET category_cursors_json=?,category_index=0,last_discovery_at='' WHERE id=1")
    .bind(JSON.stringify(cursors)).run();
  const recrawl = await lib.discoverSoundtrackCandidates(env);
  assert.match(recrawl.source,/piano/,"weekly revisit of exhausted categories");
  assert.equal(recrawl.queuedForRightsReview,0,"recrawl does not requeue duplicate recordings");
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
  // Automation triage must leave a candidate available for human rights
  // review while freeing its slot in the automated discovery queue.
  const held = await review("triage",{
    reason:"Named performer cannot be independently identified; keep for manual licensing review."
  },undefined,"cm_102");
  assert.equal(held.status,200);
  const triaged = await env.DB.prepare("SELECT status,automated_triage_reason FROM soundtrack_recordings WHERE id='cm_102'").first();
  assert.equal(triaged.status,"pending_review");
  assert.match(triaged.automated_triage_reason,/manual licensing/);
  const automaticList = await lib.handleSoundtracks(
    new Request("https://cove.test/api/fore/admin/soundtracks?status=pending_review&automation=1",{
      headers:{authorization:"Bearer "+token}
    }),env,"/admin/soundtracks","US");
  assert.ok(!(await automaticList.json()).records.some(r=>r.id==="cm_102"));
  const notEligibleForReconsideration = await lib.handleSoundtracks(
    new Request("https://cove.test/api/fore/admin/soundtracks?status=pending_review&automation=triaged",{
      headers:{authorization:"Bearer "+token}
    }),env,"/admin/soundtracks","US");
  assert.equal((await notEligibleForReconsideration.json()).records.length,0,
    "A previously ambiguous credit must remain held for staff review");
  const staffList = await lib.handleSoundtracks(
    new Request("https://cove.test/api/fore/admin/soundtracks?status=pending_review",{
      headers:{authorization:"Bearer "+token}
    }),env,"/admin/soundtracks","US");
  assert.ok((await staffList.json()).records.some(r=>r.id==="cm_102"));
  await assert.rejects(()=>review("triage",{reason:"Repeat triage of already triaged source"},undefined,"cm_102"),/untouched/i);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_review_events WHERE recording_id='cm_102' AND event_type='triage'").first()).n,1);

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
  pages[4].revisions[0].slots.main.content = "{{PD-self}} Original master released by creator.";
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
  // EU-only historical sound-recording declarations are not US commercial
  // master permissions, even when Commons calls the file public domain.
  await assert.rejects(
    () => sourceReview("approve", {...approval, composer:"Johann Sebastian Bach", performer:"Bach, Johann-Sebastian"}),
    /individual rights review/i,
    "Composer metadata must never masquerade as a modern performer",
  );
  const sourceText = pages[4].revisions[0].slots.main.content;
  pages[4].revisions[0].slots.main.content = "Bach's work, Pablo Casals on historical CD audio. {{PD-EU-audio}}";
  await assert.rejects(
    () => sourceReview("approve",approval),
    /EU-only phonogram/i,
    "EU-only audio declarations cannot authorize US publication",
  );
  pages[4].revisions[0].slots.main.content = sourceText;
  pages[4].revisions[0].slots.main.content = "Original from https://freemusicarchive.org/music/example/unknown-master";
  await assert.rejects(()=>sourceReview("approve",approval),/FMA\/Musopen-origin/i,
    "FMA-origin sources require independent confirmation of the master rights");
  pages[4].revisions[0].slots.main.content = sourceText;
  pages[4].imageinfo[0].metadata=[{name:"Copyright",value:"CC BY-NC-SA 3.0"}];
  await assert.rejects(()=>sourceReview("approve",approval),/source or license changed/i,
    "An embedded NC term must prevent commercial approval");
  delete pages[4].imageinfo[0].metadata;
  assert.equal((await sourceReview("approve",approval)).status,200,"Straightforward repository PD reliance needs no second principal");
  const sourceDecision = await env.DB.prepare("SELECT evidence_json FROM soundtrack_rights_decisions WHERE recording_id='cm_105' AND action='approve'").first();
  assert.equal(JSON.parse(sourceDecision.evidence_json).dossier.reviewMethod,"source_license");
  // Post-publication rights rechecks are different from import-time validation:
  // healthy sources keep serving; network outages retain public access but
  // record a retry; changed declared master/license immediately revokes access.
  assert.deepEqual(await lib.importOneReviewedSoundtrack(env),{stored:"cm_105"});
  assert.equal((await lib.recheckOnePublishedSoundtrack(env)).checked,"cm_105");
  assert.equal((await env.DB.prepare("SELECT rights_check_error FROM soundtrack_recordings WHERE id='cm_105'").first()).rights_check_error,"");
  upstreamUnavailable = true;
  await env.DB.prepare("UPDATE soundtrack_recordings SET rights_checked_at='2000-01-01T00:00:00Z' WHERE id='cm_105'").run();
  assert.equal((await lib.recheckOnePublishedSoundtrack(env)).reason,"source_unavailable");
  assert.equal((await env.DB.prepare("SELECT status,rights_check_error FROM soundtrack_recordings WHERE id='cm_105'").first()).status,"ready");
  assert.equal((await env.DB.prepare("SELECT rights_check_error FROM soundtrack_recordings WHERE id='cm_105'").first()).rights_check_error,"upstream_unavailable");
  upstreamUnavailable = false;
  upstreamChanged = true;
  await env.DB.prepare("UPDATE soundtrack_recordings SET rights_checked_at='2000-01-01T00:00:00Z' WHERE id='cm_105'").run();
  const oldDelete = env.BUCKET.delete;
  env.BUCKET.delete = async () => {throw new Error("Fixture R2 cleanup outage")};
  const withdrawn = await lib.recheckOnePublishedSoundtrack(env);
  assert.equal(withdrawn.revoked,"cm_105");
  const withdrawnRow = await env.DB.prepare("SELECT status,storage_key,allowed_territories_json FROM soundtrack_recordings WHERE id='cm_105'").first();
  assert.equal(withdrawnRow.status,"revoked");
  assert.equal(withdrawnRow.storage_key,null);
  assert.equal(withdrawnRow.allowed_territories_json,"[]");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_cleanup_queue").first()).n,1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_rights_decisions WHERE recording_id='cm_105' AND action='revoke'").first()).n,1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_review_events WHERE recording_id='cm_105' AND event_type='revoke'").first()).n,1);
  assert.equal((await (await listing()).json()).count,0);
  env.BUCKET.delete = oldDelete;
  await lib.importOneReviewedSoundtrack(env);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_cleanup_queue").first()).n,0);
  upstreamChanged = false;
  console.log("Soundtrack discovery, license filters, review gate, source drift, R2 checksum, attribution, territory and streaming passed.");
} finally {
  globalThis.fetch=originalFetch;
  fs.rmSync(root,{recursive:true,force:true});
}
