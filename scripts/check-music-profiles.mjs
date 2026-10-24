import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-music-profile-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["music-profile", "music-profiles.server", "reading-time"].map(
      (n) => `src/features/fore/${n}.ts`,
    ),
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const lib = await import(path.join(root, "music-profiles.server.mjs"));
  const core = await import(path.join(root, "music-profile.mjs"));
  const reading = await import(path.join(root, "reading-time.mjs"));
  const env = localBindings(root),
    now = new Date().toISOString(),
    token = "fore_svc_musicfixture.longtestsecret";
  await env.DB.prepare(
    "INSERT INTO service_principals(id,name,owner_team,created_at,updated_at) VALUES('music-fixture','Music profiler','Test',?,?)",
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO service_principal_scopes(principal_id,scope,granted_at) VALUES('music-fixture','soundtracks.review',?)",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    "INSERT INTO service_principal_credentials(id,principal_id,token_prefix,token_sha256,created_at) VALUES('music-token','music-fixture','fore_svc_musicfixture',?,?)",
  )
    .bind(createHash("sha256").update(token).digest("hex"), now)
    .run();
  const qa = { sha256: "b".repeat(64), durationSeconds: 20 };
  for (const [id, sha] of [
    ["cm_1", "a"],
    ["cm_2", "c"],
  ])
    await env.DB.prepare(
      `INSERT INTO soundtrack_recordings(id,source_title,source_page_url,source_file_url,source_sha1,source_size,mime,title,license_code,license_url,license_statement,attribution_text,evidence_json,discovered_at,updated_at,status,storage_key,storage_sha1,storage_bytes,quality_status,source_snapshot_key,reviewed_at,quality_report_json,allowed_territories_json) VALUES(?,?,'https://commons.wikimedia.org/wiki/File:Fixture','https://upload.wikimedia.org/fixture',?,2000,'audio/ogg','Fixture','CC0','https://creativecommons.org/publicdomain/zero/1.0/','CC0','Fixture attribution','{}',?,?,'ready',?,?,2000,'passed','evidence-fixture',?,?,'["US"]')`,
    )
      .bind(id, id, sha.repeat(40), now, now, id + ".ogg", sha.repeat(40), now, JSON.stringify(qa))
      .run();
  for (const id of ["cm_1", "cm_2"]) await env.BUCKET.put(id + ".ogg", new Uint8Array(2000));
  await env.DB.prepare(
    "UPDATE soundtrack_recordings SET title=CASE WHEN id='cm_2' THEN 'Fixture adagio' ELSE 'Fixture allegro' END,has_vocals=0",
  ).run();
  const call = async (route, body, authorization = token) =>
    lib.handleMusicProfiles(
      new Request("https://cove.test/api/fore" + route, {
        method: body ? "POST" : "GET",
        headers: { authorization: "Bearer " + authorization, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
      route,
      "US",
    );
  await assert.rejects(() => call("/admin/music-profiles/claim", {}, "bad"), /credential/i);
  await lib.seedMusicProfiles(env);
  const first = await (await call("/admin/music-profiles/claim", {})).json();
  assert.equal(
    first.recordingId,
    "cm_2",
    "Quiet published instrumental recordings are analyzed before unrelated masters",
  );
  const second = await (await call("/admin/music-profiles/claim", {})).json();
  assert.notEqual(
    first.recordingId,
    second.recordingId,
    "Exclusive claims distribute different exact masters",
  );
  assert.equal((await (await call("/admin/music-profiles/claim", {})).json()).skipped, "no_jobs");
  const report = {
    policy: core.MUSIC_POLICY,
    sourceSha1: first.sourceSha1,
    sha256: "b".repeat(64),
    bytes: 2000,
    durationSeconds: 20,
    decodedFully: true,
    analyzer: "fixture full-signal analyzer",
    measuredAt: now.replace("Z", "+00:00"),
    loudness: { integratedLufs: -22, truePeakDbfs: -1, loudnessRangeLu: 10, rmsDynamicRangeDb: 12 },
    signal: {
      spectralCentroidHz: 400,
      spectralRolloffHz: 1000,
      spectralFlatness: 0.1,
      zeroCrossingRate: 0.1,
      onsetsPerSecond: 1,
      tempoBpm: null,
      tempoConfidence: 0,
      tonalEntropy: 0.6,
      abruptTransitionRate: 0.1,
      rhythmicActivity: 0.25,
      energy: 0.3,
    },
    structure: {
      binSeconds: 10,
      timeline: [
        { start: 0, end: 10, rmsDbfs: -30, centroidHz: 400, onsets: 5 },
        { start: 10, end: 20, rmsDbfs: -15, centroidHz: 700, onsets: 8 },
      ],
      quietSections: [[0, 10]],
      climaxes: [[10, 20]],
      transitionPoints: [10],
    },
    semantics: null,
    limitations: [
      "Lyrics, historical performance authenticity and composition dates cannot be established by this analyzer.",
    ],
  };
  const duration = 231.170748;
  const windows = Array.from({ length: 8 }, (_, i) => ({
    start: (i * (duration - 10)) / 7,
    end: (i * (duration - 10)) / 7 + 10,
  }));
  const semanticReport = {
    ...report,
    durationSeconds: duration,
    structure: {
      ...report.structure,
      timeline: Array.from({ length: 47 }, (_, i) => ({
        start: i * 5,
        end: Math.min(duration, (i + 1) * 5),
        rmsDbfs: -22,
        centroidHz: 400,
        onsets: 2,
      })),
      binSeconds: 5,
    },
    semantics: {
      model: core.CLAP_MODEL,
      revision: core.CLAP_REVISION,
      method: "zero_shot_audio_text_similarity",
      scoreMeaning: "uncalibrated_cosine_similarity",
      sampledSeconds: 80.00000000000003,
      windows,
      moods: [],
      nuance: [],
      dimensions: {
        valence: null,
        arousal: null,
        acousticness: null,
        vocalPresence: null,
        ensembleSize: "unknown",
        scale: "unknown",
        texture: [],
        instruments: [],
      },
      confidence: 0.6,
    },
  };
  core.validateMusicReport(semanticReport);
  assert.throws(
    () =>
      core.validateMusicReport({
        ...semanticReport,
        semantics: { ...semanticReport.semantics, sampledSeconds: 80.01 },
      }),
    /less than or equal/,
  );
  assert.throws(
    () =>
      core.validateMusicReport({
        ...semanticReport,
        semantics: {
          ...semanticReport.semantics,
          windows: [
            { start: 0, end: 10 },
            { start: 9, end: 19 },
          ],
        },
      }),
    /sample coverage/,
  );
  const identity = {
    recordingId: first.recordingId,
    fingerprint: first.fingerprint,
    leaseToken: first.leaseToken,
  };
  await assert.rejects(
    () =>
      call("/admin/music-profiles/complete", {
        ...identity,
        report: { ...report, sourceSha1: "d".repeat(40) },
      }),
    /another master/,
  );
  assert.throws(
    () =>
      core.validateMusicReport({
        ...report,
        structure: { ...report.structure, timeline: report.structure.timeline.slice(0, 1) },
      }),
    /Incomplete/,
  );
  await (await call("/admin/music-profiles/complete", { ...identity, report })).json();
  const published = await (
    await call(`/soundtracks/recordings/${first.recordingId}/profile`)
  ).json();
  assert.equal(published.status, "analyzed");
  assert.equal(published.profile.audioAnalysis.durationSeconds, 20);
  assert.equal(published.profile.quietReading.policy, "cove-quiet-reading-v2");
  // Existing historical analyses can be re-scored in bounded operator calls,
  // without re-running AI, changing licenses or exposing previously held audio.
  await env.DB.prepare(
    "UPDATE music_profiles SET profile_json=json_remove(profile_json,'$.quietReading') WHERE recording_id=?",
  )
    .bind(first.recordingId)
    .run();
  assert.equal(
    (await (await call("/admin/music-profiles/rescore-quiet", {})).json()).skipped,
    "disabled",
  );
  env.FORE_QUIET_READING_RESCORE_ENABLED = "1";
  const rescored = await (await call("/admin/music-profiles/rescore-quiet", {})).json();
  assert.equal(rescored.updated, true);
  assert.equal(rescored.recordingId, first.recordingId);
  assert.equal(
    (await (await call("/admin/music-profiles/rescore-quiet", {})).json()).skipped,
    "nothing_due",
  );

  assert.ok(
    ["quiet_focus", "gentle_background", "distracting", "needs_vocal_evidence"].includes(
      published.profile.quietReading.tier,
    ),
  );
  assert.equal(
    published.profile.readingSuitability.lyrics,
    null,
    "Waveform evidence does not invent lyrics",
  );
  assert.equal(
    published.profile.audioAnalysis.semantics,
    null,
    "No pretend semantic classification",
  );
  await assert.rejects(
    () =>
      lib.handleMusicProfiles(
        new Request("https://cove.test"),
        env,
        `/soundtracks/recordings/${first.recordingId}/profile`,
        "GB",
      ),
    /unavailable/,
  );
  // Fresh catalog evidence withdraws a prior profile immediately, before the sweep.
  await env.DB.prepare(
    "UPDATE soundtrack_recordings SET composer='New credited composer' WHERE id=?",
  )
    .bind(first.recordingId)
    .run();
  assert.equal(
    (await (await call(`/soundtracks/recordings/${first.recordingId}/profile`)).json()).status,
    "pending",
  );
  await lib.seedMusicProfiles(env);
  await lib.seedMusicProfiles(env);
  const changed = await (await call("/admin/music-profiles/claim", {})).json();
  assert.equal(changed.recordingId, first.recordingId);
  assert.notEqual(changed.fingerprint, first.fingerprint);
  await assert.rejects(
    () => call("/admin/music-profiles/complete", { ...identity, report }),
    /changed/,
  );
  await env.DB.prepare("UPDATE music_profile_jobs SET lease_until='' WHERE recording_id=?")
    .bind(changed.recordingId)
    .run();
  await assert.rejects(
    () => call("/admin/music-profiles/complete", { ...changed, report }),
    /lease lost/,
  );
  // Two active claims become unavailable following the owner revoking
  // original-master permission. Neither should abort the next batch or
  // consume repeated leases on audio that no longer may be served.
  await env.DB.prepare(
    "UPDATE soundtrack_recordings SET status='revoked',storage_key=NULL WHERE id IN (?,?)",
  )
    .bind(changed.recordingId, second.recordingId)
    .run();
  const afterRevoke = await (await call("/admin/music-profiles/claim", {})).json();
  assert.equal(afterRevoke.skipped, "no_jobs");
  const withdrawnClaims = (
    await env.DB.prepare(
      "SELECT status,last_error FROM music_profile_jobs WHERE recording_id IN (?,?) ORDER BY recording_id",
    )
      .bind(changed.recordingId, second.recordingId)
      .all()
  ).results;
  assert.equal(withdrawnClaims.length, 2);
  assert.ok(
    withdrawnClaims.every(
      (job) => job.status === "failed" && job.last_error === "recording_not_published",
    ),
    "Revoked audio must never block a valid music-profiling queue",
  );
  // Reading-time values are produced by deterministic backend counts, never an LLM.
  assert.equal(reading.countReadingUnits("Don't split mother-in-law into four words.", "en"), 6);
  assert.equal(reading.countReadingUnits("日本語と English", "ja"), 5);
  assert.equal(
    reading.countReadingUnits("हिन्दी भाषा", "hi"),
    2,
    "Combining vowel marks are part of their words",
  );
  assert.equal(
    reading.countReadingUnits("e\u0301le\u0300ve", "fr"),
    1,
    "Decomposed diacritics must not split a word",
  );
  assert.ok(
    reading.countReadingUnits("ภาษาไทยเป็นภาษาที่ไม่มีช่องว่างระหว่างคำ", "th") > 1,
    "Thai uses dictionary word boundaries",
  );
  assert.equal(
    reading.estimateReadingTime({ language: "en", textUnits: 1889 }).estimatedSeconds,
    453.36,
  );
  const segmenter = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    const fallback = reading.estimateReadingTime({ language: "th", textUnits: 40 });
    assert.equal(fallback.unit, "unicode_code_points");
    assert.equal(fallback.wordCount, null);
    assert.ok(fallback.confidence <= 0.25);
  } finally {
    Intl.Segmenter = segmenter;
  }

  assert.equal(
    reading.estimateReadingTime({ language: "en", textUnits: 1000 }).estimatedMinutes,
    4,
  );
  assert.equal(
    reading.estimateReadingTime({ language: "en", textUnits: 1000, truncated: true })
      .rangeMinutes[1],
    null,
  );
  assert.equal(
    reading.estimateReadingTime({ language: "en", wordCount: 1000 }).method,
    "publisher_word_count",
  );
  assert.equal(
    reading.estimateReadingTime({ language: "en", pageEstimate: 20 }).estimatedMinutes,
    20,
  );
  assert.equal(reading.estimateReadingTime({ language: "en" }).method, "catalog_prior");
  console.log(
    "Music profiles: exact-source hashes, lease exclusivity, stale publication, territorial withdrawal, audio coverage and backend reading-time policy passed.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
