import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
import { trainRanker } from "./matching/train-ranker.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-matching-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "matching-engine",
      "matching.server",
      "matching-catalog.server",
      "literary-profile",
      "literary-profiles.server",
      "music-profiles.server",
      "music-profile",
      "account-management.server",
      "api.server",
    ].map((n) => `src/features/fore/${n}.ts`),
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const core = await import(path.join(root, "matching-engine.mjs"));
  const server = await import(path.join(root, "matching.server.mjs"));
  const catalog = await import(path.join(root, "matching-catalog.server.mjs"));
  const literary = await import(path.join(root, "literary-profile.mjs"));
  const literaryServer = await import(path.join(root, "literary-profiles.server.mjs"));
  const music = await import(path.join(root, "music-profiles.server.mjs"));
  const musicCore = await import(path.join(root, "music-profile.mjs"));
  const account = await import(path.join(root, "account-management.server.mjs"));
  const api = await import(path.join(root, "api.server.mjs"));
  const env = localBindings(root),
    now = new Date().toISOString();
  await api.handleCoveApi(new Request("https://cove.test/api/fore/catalog"), env);
  const product = await env.DB.prepare(
    "SELECT id FROM products WHERE storefront_status='active' ORDER BY id LIMIT 1",
  ).first();
  const profile = literary.emptyLiteraryProfile();
  profile.moods = { value: ["reflective", "melancholic"], confidence: 0.9, evidence: ["text"] };
  profile.sensoryAtmosphere = {
    value: ["delicate", "fragile", "uncanny"],
    confidence: 0.9,
    evidence: ["text"],
  };
  profile.energy = { value: 0.25, confidence: 0.9, evidence: ["text"] };
  profile.tension = { value: 0.2, confidence: 0.9, evidence: ["text"] };
  profile.valence = { value: -0.4, confidence: 0.9, evidence: ["text"] };
  profile.musicalAffinity.confidence = 0.9;
  profile.musicalAffinity.value.instruments = ["piano"];
  profile.listening.maxEnergy = 0.8;
  const duration = {
    policy: "cove-reading-time-v2",
    estimatedMinutes: 3,
    estimatedSeconds: 180,
    rangeMinutes: [2, 5],
    rangeSeconds: [120, 300],
    confidence: 0.9,
    lowerBoundOnly: false,
    method: "epub_text",
  };
  const context = {
    productId: product.id,
    fingerprint: "book-pin",
    status: "analyzed",
    profile,
    readingTime: duration,
    chapterFallback: false,
    trainingEligible: true,
    sections: [
      {
        section_id: "s1",
        profile_json: JSON.stringify(profile),
        reading_time_json: JSON.stringify({
          ...duration,
          estimatedMinutes: 1,
          estimatedSeconds: 60,
          rangeMinutes: [1, 2],
          rangeSeconds: [40, 100],
        }),
      },
      {
        section_id: "s2",
        profile_json: JSON.stringify(profile),
        reading_time_json: JSON.stringify({
          ...duration,
          estimatedMinutes: 2,
          estimatedSeconds: 120,
          rangeMinutes: [1, 3],
          rangeSeconds: [80, 200],
        }),
      },
    ],
  };
  const reports = new Map();
  const makeReport = (id, energy = 0.2, mood = "wistful") => ({
    policy: musicCore.MUSIC_POLICY,
    sourceSha1: createHash("sha1").update(id).digest("hex"),
    sha256: createHash("sha256").update(id).digest("hex"),
    bytes: 2000,
    durationSeconds: 60,
    decodedFully: true,
    analyzer: "synthetic matching fixture",
    measuredAt: now,
    loudness: { integratedLufs: -25, truePeakDbfs: -2, loudnessRangeLu: 4, rmsDynamicRangeDb: 6 },
    signal: {
      spectralCentroidHz: 500,
      spectralRolloffHz: 1200,
      spectralFlatness: 0.1,
      zeroCrossingRate: 0.1,
      onsetsPerSecond: 0.4,
      tempoBpm: null,
      tempoConfidence: 0,
      tonalEntropy: 0.5,
      abruptTransitionRate: 0.02,
      rhythmicActivity: 0.1,
      energy,
    },
    structure: {
      binSeconds: 30,
      timeline: [
        { start: 0, end: 30, rmsDbfs: -25, centroidHz: 500, onsets: 3 },
        { start: 30, end: 60, rmsDbfs: -25, centroidHz: 500, onsets: 3 },
      ],
      quietSections: [],
      climaxes: [],
      transitionPoints: [],
    },
    semantics: {
      model: musicCore.CLAP_MODEL,
      revision: musicCore.CLAP_REVISION,
      method: "zero_shot_audio_text_similarity",
      scoreMeaning: "uncalibrated_cosine_similarity",
      sampledSeconds: 20,
      windows: [
        { start: 0, end: 10 },
        { start: 50, end: 60 },
      ],
      moods: [{ label: mood, similarity: 0.4 }],
      nuance: ["delicate and fragile", "slightly uncanny"],
      dimensions: {
        valence: 0.3,
        arousal: 0.2,
        acousticness: 0.9,
        vocalPresence: 0.1,
        ensembleSize: "solo",
        scale: "intimate",
        texture: ["sparse open texture"],
        instruments: ["piano"],
      },
      confidence: 0.6,
    },
    limitations: ["Synthetic regression fixture, not a human accuracy benchmark."],
  });
  // 360 ready recordings prove matching does not inherit the public list's 300 cap.
  async function addFixture(
    i,
    energy = i === 360 ? 0.2 : 0.28,
    mood = i === 360 ? "melancholic" : "playful",
  ) {
    const id = `cm_${i}`,
      report = makeReport(id, energy, mood);
    reports.set(id, report);
    await env.DB.prepare(
      "INSERT INTO soundtrack_recordings(id,source_title,source_page_url,source_file_url,source_sha1,source_size,mime,title,performer,composer,license_code,license_url,license_statement,attribution_text,evidence_json,discovered_at,updated_at,status,storage_key,storage_sha1,storage_bytes,quality_status,source_snapshot_key,reviewed_at,quality_report_json,allowed_territories_json,has_vocals,energy) VALUES(?,?,'https://commons.wikimedia.org/wiki/File:Fixture','https://upload.wikimedia.org/fixture',?,2000,'audio/ogg',?,'Fixture performer','Fixture composer','CC0','https://creativecommons.org/publicdomain/zero/1.0/','CC0','Fixture attribution','{}',?,?,'ready',?,?,2000,'passed','fixture-evidence',?,?,'[\"US\"]',0,0.2)",
    )
      .bind(
        id,
        id,
        report.sourceSha1,
        `Fixture ${i}`,
        now,
        now,
        id + ".ogg",
        report.sourceSha1,
        now,
        JSON.stringify({ sha256: report.sha256, durationSeconds: 60 }),
      )
      .run();
  }
  for (let i = 1; i <= 360; i++) await addFixture(i);
  for (let i = 0; i < 4; i++) await music.seedMusicProfiles(env, 100);
  for (const [id, report] of reports) {
    musicCore.validateMusicReport(report);
    await env.DB.prepare(
      "UPDATE music_profiles SET status='analyzed',profile_json=? WHERE recording_id=?",
    )
      .bind(
        JSON.stringify({
          audioAnalysis: report,
          analysisCoverage: { fullSignal: true, semantic: "sampled", semanticFraction: 1 / 3 },
        }),
        id,
      )
      .run();
  }
  // A globally low-ranked motif must still reach the planner when it is an
  // excellent fit at a later narrative checkpoint. All choices remain drawn
  // from the globally eligible catalog and no candidate repeats.
  const toyRanked = Array.from({ length: 120 }, (_, i) => ({ id: `r_${i}` }));
  const later = structuredClone(profile);
  later.moods.value = ["tense"];
  const selected = core.selectNarrativeCandidates(
    toyRanked,
    [profile, later],
    (passage, candidate) =>
      passage === later && candidate.id === "r_119" ? 1 : -Number(candidate.id.slice(2)),
  );
  assert.equal(selected.length, 80);
  assert.equal(new Set(selected.map((r) => r.id)).size, 80);
  assert.ok(
    selected.some((r) => r.id === "r_119"),
    "Later-scene local matches cannot disappear behind the global top-80 cutoff",
  );
  assert.deepEqual(selected.slice(0, 40), toyRanked.slice(0, 40));
  assert.deepEqual(
    core.selectNarrativeCandidates(toyRanked, [], () => 1),
    toyRanked.slice(0, 80),
    "Missing chapter evidence falls back to the existing exhaustive global shortlist",
  );
  assert.deepEqual(
    core.selectNarrativeCandidates(toyRanked, [profile, later], (p, r) =>
      p === later && r.id === "r_119" ? 1 : -Number(r.id.slice(2)),
    ),
    selected,
    "Arc-aware retrieval is deterministic for fixed book and recording inputs",
  );
  const eligible = await catalog.loadMatchingRecordings(env, "US", profile, "atmosphere");
  assert.equal(eligible.recordings.length, 360);
  assert.equal(eligible.retrieval.exhaustive, true);
  const request = (query = "", method = "GET", body) =>
    new Request("https://cove.test/api/fore/books/fixture/literary-profile/playlist" + query, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const result = await server.buildMatchingPlaylist(request(), env, "US", context);
  assert.equal(
    result.matches[0].id,
    "cm_360",
    "Actual audio compatibility beats identical catalog mood/energy tags beyond item 300",
  );
  assert.equal(result.playlist.durationSeconds, 180);
  assert.equal(result.playlist.tracks.length, 3);
  assert.equal(new Set(result.playlist.tracks.map((t) => t.id)).size, 3);
  assert.ok(
    result.playlist.tracks.every(
      (t) => t.recording.attribution && t.recording.licenseUrl && !("audio" in t.recording),
    ),
  );
  assert.equal(
    (await server.buildMatchingPlaylist(request(), env, "US", context)).inputFingerprint,
    result.inputFingerprint,
    "Identical evidence produces a stable matching fingerprint",
  );
  const evolving = structuredClone(context);
  evolving.sections[0].profile_json = JSON.stringify({
    ...profile,
    moods: { ...profile.moods, value: ["warm"] },
  });
  assert.notEqual(
    (await server.buildMatchingPlaylist(request(), env, "US", evolving)).inputFingerprint,
    result.inputFingerprint,
    "An evolving chapter analysis changes the matching fingerprint without a source change",
  );
  const recount = { ...context, readingTime: { ...duration, estimatedSeconds: 210 } };
  assert.notEqual(
    (await server.buildMatchingPlaylist(request(), env, "US", recount)).inputFingerprint,
    result.inputFingerprint,
    "Duration recounts invalidate the matching snapshot",
  );
  const stored = await env.DB.prepare(
    "SELECT profile_json FROM music_profiles WHERE recording_id='cm_360'",
  ).first();
  const remeasured = JSON.parse(stored.profile_json);
  remeasured.audioAnalysis.signal.energy = 0.21;
  await env.DB.prepare("UPDATE music_profiles SET profile_json=? WHERE recording_id='cm_360'")
    .bind(JSON.stringify(remeasured))
    .run();
  assert.notEqual(
    (await server.buildMatchingPlaylist(request(), env, "US", context)).inputFingerprint,
    result.inputFingerprint,
    "Audio analysis changes cannot share a stale matching fingerprint",
  );
  await env.DB.prepare("UPDATE music_profiles SET profile_json=? WHERE recording_id='cm_360'")
    .bind(stored.profile_json)
    .run();
  const chapter = await server.buildMatchingPlaylist(request("?spine=1&mode=focus"), env, "US", {
    ...context,
    sections: [context.sections[1]],
  });
  assert.equal(
    chapter.readingTime.estimatedSeconds,
    120,
    "Chapter uses its own seconds, not whole-book duration",
  );
  assert.equal(chapter.playlist.targetSeconds, 120);
  await assert.rejects(
    () => server.buildMatchingPlaylist(request("?mode=bogus"), env, "US", context),
    /Invalid playlist options/,
  );
  const quiet = eligible.recordings.find((r) => r.id === "cm_360"),
    options = { mode: "focus", vocals: "none", progress: 0, maxTracks: 10 };
  assert.equal(
    core.scoreRecording(
      profile,
      { ...quiet, hasVocals: null },
      options,
      core.readingDuration(duration),
    ).excluded,
    "instrumental_requirement",
  );
  assert.equal(
    core.scoreRecording(
      profile,
      { ...quiet, audio: { ...quiet.audio, signal: { ...quiet.audio.signal, energy: 0.9 } } },
      options,
      core.readingDuration(duration),
    ).excluded,
    "energy_ceiling",
  );
  const otherPerformance = structuredClone(quiet);
  otherPerformance.audio.signal.energy = 0.7;
  assert.equal(
    core.scoreRecording(profile, otherPerformance, options, core.readingDuration(duration))
      .excluded,
    "energy_ceiling",
    "Same composition can have an unsuitable performance",
  );
  const unknown = literary.emptyLiteraryProfile();
  assert.equal(
    core.scoreRecording(unknown, quiet, options, core.readingDuration(duration)).excluded,
    "insufficient_literary_evidence",
  );
  const ranked = result.matches.map((m) =>
    core.scoreRecording(
      profile,
      eligible.recordings.find((r) => r.id === m.id),
      { ...options, mode: "atmosphere" },
      core.readingDuration(duration),
    ),
  );
  const duplicate = structuredClone(ranked[0]);
  duplicate.id = "duplicate";
  duplicate.recording = { ...duplicate.recording, id: "duplicate" };
  const sequence = core.sequencePlaylist(
    [ranked[0], duplicate],
    profile,
    options,
    core.readingDuration(duration),
    [],
  );
  assert.equal(
    sequence.tracks.length,
    1,
    "The same exact master cannot repeat under a different ID",
  );
  assert.equal(sequence.coversEstimatedSession, false);
  const lowerBound = core.sequencePlaylist(
    ranked,
    profile,
    options,
    { ...core.readingDuration(duration), lowerBoundOnly: true },
    [],
  );
  assert.equal(lowerBound.fullRemainingBookPlanned, false);
  const warmProfile = structuredClone(profile),
    darkProfile = structuredClone(profile);
  warmProfile.moods.value = ["warm", "tender"];
  warmProfile.tension.value = 0.05;
  darkProfile.moods.value = ["tense", "menacing"];
  darkProfile.tension.value = 0.9;
  const warmRecording = structuredClone(quiet),
    darkRecording = structuredClone(quiet);
  warmRecording.id = "warm";
  warmRecording.title = "Warm";
  warmRecording.composer = "Composer A";
  darkRecording.id = "dark";
  darkRecording.title = "Dark";
  darkRecording.composer = "Composer B";
  warmRecording.audio.sourceSha1 = "a".repeat(40);
  darkRecording.audio.sourceSha1 = "b".repeat(40);
  warmRecording.audio.semantics.moods = [
    { label: "warm", similarity: 0.4 },
    { label: "romantic", similarity: 0.4 },
  ];
  darkRecording.audio.semantics.moods = [
    { label: "tense", similarity: 0.4 },
    { label: "menacing", similarity: 0.4 },
  ];
  const neutralProfile = structuredClone(profile);
  neutralProfile.moods.value = ["warm", "tense"];
  neutralProfile.tension.value = 0.5;
  const arc = [
    { sectionId: "warm", seconds: 60, profile: warmProfile },
    { sectionId: "dark", seconds: 60, profile: darkProfile },
  ];
  const arcDuration = { ...core.readingDuration(duration), estimatedSeconds: 120 };
  const arcOptions = { ...options, mode: "immersion" };
  const arcCandidates = [warmRecording, darkRecording].map((r) =>
    core.scoreRecording(neutralProfile, r, arcOptions, arcDuration),
  );
  const arcSequence = core.sequencePlaylist(
    arcCandidates,
    neutralProfile,
    arcOptions,
    arcDuration,
    arc,
  );
  assert.deepEqual(
    arcSequence.tracks.map((t) => t.id),
    ["warm", "dark"],
    "Order follows chapter emotional targets, not just one book-wide score",
  );
  const advanced = core.sequencePlaylist(
    arcCandidates,
    neutralProfile,
    { ...arcOptions, progress: 0.5 },
    arcDuration,
    arc,
  );
  assert.equal(
    advanced.tracks[0].id,
    "dark",
    "Reading progress changes the next passage's musical context",
  );
  const loudTransition = structuredClone(darkRecording);
  loudTransition.audio.entry.rmsDbfs = 0;
  const smoother = structuredClone(darkRecording);
  smoother.id = "smooth";
  smoother.audio.sourceSha1 = "c".repeat(40);
  const transitions = core.sequencePlaylist(
    [
      core.scoreRecording(warmProfile, warmRecording, arcOptions, arcDuration),
      core.scoreRecording(warmProfile, loudTransition, arcOptions, arcDuration),
      core.scoreRecording(warmProfile, smoother, arcOptions, arcDuration),
    ],
    warmProfile,
    arcOptions,
    arcDuration,
    [],
  );
  assert.ok(
    !transitions.tracks.some((t) => t.id === loudTransition.id),
    "Abrupt measured entries lose to equally compatible smoother recordings",
  );
  const pinned = quiet.fingerprint;
  await env.DB.prepare(
    "UPDATE soundtrack_recordings SET composer='Changed provenance' WHERE id='cm_360'",
  ).run();
  assert.equal(
    (await catalog.loadMatchingRecordings(env, "US", profile, "atmosphere", [quiet.id])).recordings
      .length,
    0,
    "Catalog change withdraws stale matching input immediately",
  );
  await env.DB.prepare(
    "UPDATE soundtrack_recordings SET composer='Fixture composer' WHERE id='cm_360'",
  ).run();
  assert.equal(
    (await catalog.loadMatchingRecordings(env, "US", profile, "atmosphere", [quiet.id]))
      .recordings[0].fingerprint,
    pinned,
  );
  await env.DB.prepare(
    "UPDATE soundtrack_recordings SET allowed_territories_json='[\"GB\"]' WHERE id='cm_360'",
  ).run();
  assert.equal(
    (await catalog.loadMatchingRecordings(env, "US", profile, "atmosphere", [quiet.id])).recordings
      .length,
    0,
  );
  await env.DB.prepare(
    "UPDATE soundtrack_recordings SET allowed_territories_json='[\"US\"]' WHERE id='cm_360'",
  ).run();
  await env.DB.prepare("UPDATE soundtrack_recordings SET status='revoked' WHERE id='cm_360'").run();
  assert.equal(
    (await catalog.loadMatchingRecordings(env, "US", profile, "atmosphere", [quiet.id])).recordings
      .length,
    0,
  );
  await env.DB.prepare("UPDATE soundtrack_recordings SET status='ready' WHERE id='cm_360'").run();
  await env.DB.prepare(
    "UPDATE music_profiles SET status='provisional' WHERE recording_id='cm_1'",
  ).run();
  assert.equal(
    await env.DB.prepare(
      "SELECT recording_id FROM matching_audio_index WHERE recording_id='cm_1'",
    ).first(),
    null,
    "Policy invalidation clears materialized features",
  );
  // Identity and explicit feedback stay private and cannot become editorial labels.
  for (const id of ["matching-alice", "matching-bob"])
    await env.DB.prepare("INSERT INTO profiles(user_id,name,created_at) VALUES(?,?,?)")
      .bind(id, id, now)
      .run();
  const alice = {
    id: "matching-alice",
    name: "Alice",
    email: "alice@test.invalid",
    registered: true,
  };
  const bob = { ...alice, id: "matching-bob" };
  const call = (route, method, body, identity = alice) =>
    server.handleMatchingAdministration(
      request("", method, body),
      env,
      route,
      "US",
      identity,
      async () => context,
    );
  await assert.rejects(
    () =>
      call(
        "/matching/feedback",
        "POST",
        { productId: product.id, recordingId: quiet.id, reason: "poor_fit" },
        null,
      ),
    /Sign in/,
  );
  await call("/matching/feedback", "POST", {
    productId: product.id,
    recordingId: quiet.id,
    reason: "poor_fit",
  });
  const aliceResult = await server.buildMatchingPlaylist(request(), env, "US", context, alice);
  assert.ok(!aliceResult.matches.some((m) => m.id === quiet.id));
  assert.equal(
    (await server.buildMatchingPlaylist(request(), env, "US", context, bob)).matches[0].id,
    quiet.id,
  );
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) count FROM matching_evaluations").first()).count,
    0,
  );
  await call("/matching/preferences", "PUT", { mode: "focus", avoidRecordingIds: ["cm_2"] });
  const exported = await account.accountDataExport(env.DB, alice.id);
  assert.equal(exported.matching.feedback.length, 1);
  assert.ok(exported.matching.preferences.preferences_json.includes("focus"));
  await call("/matching/feedback", "DELETE");
  await env.DB.prepare("DELETE FROM profiles WHERE user_id=?").bind(alice.id).run();
  assert.equal(
    (
      await env.DB.prepare("SELECT COUNT(*) count FROM matching_preferences WHERE user_id=?")
        .bind(alice.id)
        .first()
    ).count,
    0,
  );
  // The trained path is exercised with SYNTHETIC fixtures, not reported as accuracy evidence.
  const examples = [];
  for (let i = 1; i <= 2500; i++) {
    const a = Object.fromEntries(core.featureNames.map((k) => [k, 0])),
      b = { ...a };
    a.mood = 1;
    b.energy = 1;
    examples.push({
      id: i,
      policy: core.MATCHING_POLICY,
      product_id: product.id,
      book_fingerprint: "fixture",
      spine: "",
      mode: "atmosphere",
      book_family: `fixture_book_${i % 97}`,
      a: { workFamily: `fixture_work_${i % 101}`, features: a },
      b: { workFamily: `fixture_work_${(i * 7 + 3) % 103}`, features: b },
      preferred: "b",
      created_at: now,
    });
  }
  const artifact = await trainRanker(examples, core, "synthetic_regression_only");
  assert.ok(artifact.weights.energy > artifact.weights.mood);
  await assert.rejects(
    () => trainRanker(examples.slice(0, 20), core, "insufficient"),
    /Insufficient/,
  );
  const groups = core.evaluateRanker(examples, artifact.weights).subsets;
  const trainBooks = new Set(groups.train.map((r) => r.book_family)),
    trainWorks = new Set(groups.train.flatMap((r) => [r.a.workFamily, r.b.workFamily]));
  assert.ok(groups.bookHoldout.every((r) => !trainBooks.has(r.book_family)));
  assert.ok(
    groups.musicHoldout.every(
      (r) => !trainWorks.has(r.a.workFamily) && !trainWorks.has(r.b.workFamily),
    ),
  );
  const token = "fore_svc_musicfixture.longtestsecret";
  await env.DB.prepare(
    "INSERT INTO service_principals(id,name,owner_team,created_at,updated_at) VALUES('matching-editor','Fixture editor','Test',?,?)",
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO service_principal_scopes(principal_id,scope,granted_at) VALUES('matching-editor','literary.profiles.manage',?)",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    "INSERT INTO service_principal_credentials(id,principal_id,token_prefix,token_sha256,created_at) VALUES('matching-editor-token','matching-editor','fore_svc_musicfixture',?,?)",
  )
    .bind(createHash("sha256").update(token).digest("hex"), now)
    .run();
  const admin = (route, method, body, resolved = context) =>
    server.handleMatchingAdministration(
      new Request("https://cove.test/api/fore" + route, {
        method,
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      route.split("?")[0],
      "US",
      null,
      async () => resolved,
    );
  await assert.rejects(
    () => admin("/admin/matching/models", "POST", { artifact, activate: true }),
    /authoritative/,
  );
  for (const row of examples)
    await env.DB.prepare(
      "INSERT INTO matching_evaluations(id,policy,actor,product_id,book_fingerprint,spine,mode,book_family,a_json,b_json,preferred,created_at) VALUES(?,?,'synthetic-fixture',?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        row.id,
        row.policy,
        row.product_id,
        row.book_fingerprint,
        row.spine,
        row.mode,
        row.book_family,
        JSON.stringify(row.a),
        JSON.stringify(row.b),
        row.preferred,
        row.created_at,
      )
      .run();
  await admin("/admin/matching/models", "POST", { artifact, activate: true });
  assert.equal((await server.activeMatchingRanker(env)).id, artifact.id);
  await admin("/admin/matching/models", "DELETE");
  assert.equal(await server.activeMatchingRanker(env), undefined);
  await assert.rejects(
    () =>
      admin("/admin/matching/models", "POST", {
        artifact: {
          ...artifact,
          id: "tampered",
          weights: { ...artifact.weights, mood: 20, energy: 0 },
        },
        activate: true,
      }),
    /reproduce/,
  );
  const dispatched = await api.handleCoveApi(
    new Request("https://cove.test/api/fore/admin/matching/models", {
      headers: { authorization: "Bearer " + token },
    }),
    env,
  );
  assert.equal(
    dispatched.status,
    200,
    "Service-scoped matching administration is reachable through the full API",
  );
  const privateContext = { ...context, trainingEligible: false };
  await assert.rejects(
    () =>
      admin(
        "/admin/matching/evaluations",
        "POST",
        {
          productId: product.id,
          a: "cm_2",
          b: "cm_3",
          preferred: "a",
          bookFamily: "book",
          workFamilyA: "work2",
          workFamilyB: "work3",
          assessorKind: "human",
          judgmentId: "00000000-0000-4000-8000-000000000001",
        },
        privateContext,
      ),
    /Private imports/,
  );
  assert.equal(
    (
      await literaryServer.handleLiteraryProfiles(
        new Request("https://cove.test"),
        env,
        "/matching/preferences",
        "US",
        bob,
      )
    ).status,
    200,
    "New matching routes are reachable through the main backend dispatcher",
  );
  const judgment = {
    productId: product.id,
    a: "cm_2",
    b: "cm_3",
    preferred: "a",
    bookFamily: "editorial-book",
    workFamilyA: "editorial-work2",
    workFamilyB: "editorial-work3",
    assessorKind: "human",
    judgmentId: "00000000-0000-4000-8000-000000000002",
  };
  assert.equal(
    (await (await admin("/admin/matching/evaluations", "POST", judgment)).json()).saved,
    true,
  );
  assert.equal(
    (await (await admin("/admin/matching/evaluations", "POST", judgment)).json()).deduplicated,
    true,
    "Retrying the same judgment cannot inflate the training dataset",
  );
  const page = await (await admin("/admin/matching/evaluations?after=2499", "GET")).json();
  assert.equal(page.evaluations.length, 2);
  assert.ok(page.evaluations.at(-1).a.features && page.evaluations.at(-1).b.fingerprint);
  for (let i = 361; i <= 1010; i++) await addFixture(i, 0.2125, "melancholic");
  for (let i = 0; i < 14; i++) await music.seedMusicProfiles(env, 100);
  for (let i = 361; i <= 1010; i++)
    await env.DB.prepare(
      "UPDATE music_profiles SET status='analyzed',profile_json=? WHERE recording_id=?",
    )
      .bind(
        JSON.stringify({
          audioAnalysis: reports.get(`cm_${i}`),
          analysisCoverage: { fullSignal: true, semantic: "sampled", semanticFraction: 1 / 3 },
        }),
        `cm_${i}`,
      )
      .run();
  await env.DB.prepare(
    "UPDATE soundtrack_recordings SET status='revoked' WHERE CAST(SUBSTR(id,4) AS INTEGER)>360",
  ).run();
  const shortlisted = await catalog.loadMatchingRecordings(env, "US", profile, "atmosphere");
  assert.equal(shortlisted.retrieval.exhaustive, false);
  assert.equal(shortlisted.retrieval.method, "indexed_energy_and_mood_shortlist");
  assert.ok(
    shortlisted.recordings.some((r) => r.id === "cm_360"),
    "650 revoked nearest neighbors cannot crowd playable music out of a bounded shortlist",
  );
  assert.ok(shortlisted.recordings.every((r) => Number(r.id.slice(3)) <= 360));
  assert.ok(shortlisted.retrieval.retrieved <= 600);
  console.log(
    "Matching: actual-audio features, 360-record exhaustive and 1,010-index shortlist retrieval, chapter duration, abstention, live rights/fingerprint gates, sequencing, personal privacy and reproducible human-ranker activation passed. Training fixtures are synthetic, not perceptual accuracy measurements.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
