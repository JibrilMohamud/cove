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
    assert.equal(args[2].sha1, sha1, "R2 receives the expected source checksum");
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

  // Simulate a genuine review by writing the attested state in the fixture.
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
  const stored = await lib.importOneReviewedSoundtrack(env);
  assert.equal(stored.stored,"cm_101");
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
  await assert.rejects(() => lib.handleSoundtracks(
    new Request("https://cove.test/api/fore" + audioPath),env,audioPath,"FR"),
  /unavailable/i);
  await assert.rejects(() => lib.handleSoundtracks(
    new Request("https://cove.test/api/fore/admin/soundtracks"),env,"/admin/soundtracks","US"),
  /credential/i,"review endpoints never accept anonymous access");
  assert.equal(mediaRequests,1);
  console.log("Soundtrack discovery, license filters, review gate, source drift, R2 checksum, attribution, territory and streaming passed.");
} finally {
  globalThis.fetch=originalFetch;
  fs.rmSync(root,{recursive:true,force:true});
}
