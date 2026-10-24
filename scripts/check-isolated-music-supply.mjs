import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-music-supply-"));
try {
  fs.mkdirSync(path.join(root, "drizzle"));
  fs.copyFileSync(
    "infra/music/0001_isolated_music_supply.sql",
    path.join(root, "drizzle", "0001_isolated_music_supply.sql"),
  );
  fs.copyFileSync(
    "infra/music/0002_qualification_leases.sql",
    path.join(root, "drizzle", "0002_qualification_leases.sql"),
  );
  fs.copyFileSync(
    "infra/music/0003_execution_quotas_metrics_reviews.sql",
    path.join(root, "drizzle", "0003_execution_quotas_metrics_reviews.sql"),
  );
  await build({
    entryPoints: ["src/music-supply/policy.ts", "src/music-supply/worker.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { validateMusicContract, validateMusicMaster, validateMusicQuality } = await import(
    path.join(root, "policy.mjs")
  );
  const worker = (await import(path.join(root, "worker.mjs"))).default;
  const isolated = localBindings(root);
  const objects = new Map();
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const bucket = {
    async put(key, body, options = {}) {
      const bytes =
        typeof body === "string"
          ? Buffer.from(body)
          : body?.getReader
            ? Buffer.from(await new Response(body).arrayBuffer())
            : Buffer.from(body);
      const actual = sha(bytes);
      if (options.sha256 && options.sha256 !== actual) throw Error("Checksum mismatch");
      objects.set(key, { bytes, sha256: actual });
    },
    async head(key) {
      const row = objects.get(key);
      return row
        ? { size: row.bytes.length, checksums: { sha256: Buffer.from(row.sha256, "hex") } }
        : null;
    },
    async get(key) {
      const row = objects.get(key);
      return row ? { size: row.bytes.length, body: new Blob([row.bytes]).stream() } : null;
    },
  };
  const keys = {
    operator: "operator-" + "a".repeat(56),
    reviewer: "reviewer-" + "b".repeat(56),
    ingest: "ingest-" + "c".repeat(56),
    qa: "qa-" + "d".repeat(56),
    analyst: "analyst-" + "e".repeat(56),
    musicReviewer: "reviewer-music-" + "f".repeat(56),
  };
  const env = {
    MUSIC_DB: isolated.DB,
    MUSIC_BUCKET: bucket,
    MUSIC_SUPPLY_ENABLED: "0",
    MUSIC_OPERATOR_TOKEN_SHA256: sha(keys.operator),
    MUSIC_LICENSE_REVIEWER_TOKEN_SHA256: sha(keys.reviewer),
    MUSIC_INGEST_TOKEN_SHA256: sha(keys.ingest),
    MUSIC_QA_TOKEN_SHA256: sha(keys.qa),
  };
  async function invoke(uri, method, token, body) {
    const request = new Request("https://music.qa.test" + uri, {
      method,
      headers: {
        ...(token ? { authorization: "Bearer " + keys[token] } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await worker.fetch(request, env);
    return { status: response.status, result: await response.json() };
  }
  assert.equal((await invoke("/health", "GET")).result.processingEnabled, false);
  assert.equal((await invoke("/v1/contracts", "POST", "operator", {})).status, 503);
  env.MUSIC_SUPPLY_ENABLED = "1";
  assert.equal((await invoke("/v1/contracts", "POST", undefined, {})).status, 401);
  const ref = await invoke("/v1/evidence/supplier-1", "POST", "operator", {
    contractId: "supplier-1",
    licensor: "Example Rights Holder",
    authorizingInstrument: "Synthetic fixture reviewed distribution agreement",
    commercialStreaming: true,
    masterRights: true,
    compositionRights: true,
  });
  assert.equal(ref.status, 201);
  const contract = {
    id: "supplier-1",
    provider: "Fixture Rights Publisher",
    licensedOrigin: "https://licensed.example.test/files/",
    territories: ["US", "CA"],
    expiresAt: "2035-02-01T00:00:00.000Z",
    evidenceKey: ref.result.evidenceKey,
    evidenceSha256: ref.result.evidenceSha256,
    commercialStreaming: true,
    masterRights: true,
    performanceRights: true,
    compositionRights: true,
    arrangementRights: true,
    lyricsRights: true,
  };
  for (const badOrigin of [
    "https://127.0.0.1/files/",
    "https://169.254.169.254/files/",
    "https://[::1]/files/",
    "https://metadata.google.internal/files/",
    "https://localhost/files/",
  ]) {
    assert.throws(
      () => validateMusicContract({ ...contract, licensedOrigin: badOrigin }),
      /music_unsafe_source_url/,
    );
  }
  assert.equal(
    (await invoke("/v1/contracts", "POST", "operator", contract)).result.status,
    "pending",
  );
  const bytes = Buffer.alloc(4096, 44),
    checksum = sha(bytes);
  const manifest = {
    id: "fixture-master-1",
    contractId: contract.id,
    title: "Original Instrumental Test",
    composer: "Fixture Composer",
    performer: "Fixture Performer",
    workKey: "fixture-work-1",
    sha256: checksum,
    bytes: bytes.length,
    mime: "audio/ogg",
    territory: ["US"],
    hasVocals: false,
    sourceUrl: "https://licensed.example.test/files/master-1.ogg",
    sourceLicenseId: "signed-line-item-1",
    attribution: "Fixture composer & performer — original test master",
  };
  assert.equal((await invoke("/v1/masters", "POST", "ingest", manifest)).status, 409);
  assert.equal(
    (await invoke("/v1/contracts/supplier-1/activate", "POST", "operator", {})).status,
    401,
  );
  assert.equal(
    (
      await invoke("/v1/contracts/supplier-1/activate", "POST", "reviewer", {
        reviewer: "legal-qa",
        reviewReference: "signed-evidence-synthetic-2026",
        evidenceSha256: contract.evidenceSha256,
        confirmedFiveLayers: true,
      })
    ).status,
    200,
  );
  assert.equal((await invoke("/v1/masters", "POST", "ingest", manifest)).status, 201);
  assert.equal((await invoke("/v1/masters", "POST", "ingest", manifest)).result.created, false);
  assert.throws(
    () =>
      validateMusicMaster({ ...manifest, territory: ["FR"] }, { ...contract, status: "active" }),
    /covered/,
  );
  assert.throws(
    () =>
      validateMusicMaster(
        { ...manifest, sourceUrl: "https://evil.example/files/1" },
        { ...contract, status: "active" },
      ),
    /outside/,
  );
  assert.throws(
    () => validateMusicQuality({ sha256: checksum }, checksum, bytes.length),
    /quality/,
  );
  const fakeAudio = new Request("https://music.qa.test/v1/masters/fixture-master-1/audio", {
    method: "PUT",
    headers: {
      authorization: "Bearer " + keys.ingest,
      "content-type": "audio/ogg",
      "content-length": String(bytes.length),
    },
    body: bytes,
  });
  assert.equal((await worker.fetch(fakeAudio, env)).status, 200);
  const queue = await invoke("/v1/qa/staged", "GET", "qa");
  assert.equal(queue.status, 200);
  assert.equal(queue.result.items[0].id, manifest.id);
  assert.equal((await invoke("/v1/qa/staged", "GET", "ingest")).status, 401);
  const privateRead = await worker.fetch(
    new Request("https://music.qa.test/v1/qa/masters/" + manifest.id + "/audio", {
      headers: { authorization: "Bearer " + keys.qa },
    }),
    env,
  );
  assert.equal(privateRead.status, 200);
  assert.equal(sha(Buffer.from(await privateRead.arrayBuffer())), checksum);
  const unauthorizedRead = await worker.fetch(
    new Request("https://music.qa.test/v1/qa/masters/" + manifest.id + "/audio"),
    env,
  );
  assert.equal(unauthorizedRead.status, 401);
  assert.equal(
    (await invoke("/v1/masters/fixture-master-1/quality", "POST", "operator", {})).status,
    401,
  );
  const report = {
    sha256: checksum,
    bytes: bytes.length,
    decodedFully: true,
    durationSeconds: 180,
    integratedLufs: -22,
    truePeakDbfs: -2,
    silenceRatio: 0.01,
    clippedSampleRatio: 0,
  };
  assert.equal(
    (await invoke("/v1/masters/fixture-master-1/quality", "POST", "qa", report)).status,
    202,
  );
  const market = await invoke("/v1/operator/preview-catalog?territory=US", "GET", "operator");
  assert.equal(market.status, 200);
  assert.equal(market.result.scope, "isolated_qualified_nonpublic");
  assert.equal(market.result.items.length, 1);
  assert.equal(market.result.items[0].id, manifest.id);
  assert.equal(market.result.items[0].quietSuitability, "unverified");
  assert.equal(
    (await invoke("/v1/operator/preview-catalog?territory=CA", "GET", "operator")).result.items
      .length,
    0,
  );
  assert.equal((await invoke("/v1/operator/preview-catalog", "GET", "ingest")).status, 401);
  const first = await invoke("/v1/operator/outbox?limit=1", "GET", "operator");
  assert.equal(first.result.items[0].action, "master_qualified");
  assert.equal(first.result.items[0].publishable, 1);
  const cursor = first.result.nextCursor;
  assert.equal(
    (await invoke("/v1/operator/outbox?after=" + cursor, "GET", "operator")).result.items.length,
    0,
  );

  // A second fully QA-passed master exercises the opt-in quietness gate.
  assert.equal((await invoke("/v1/analysis/claim", "POST", "qa")).status, 503);
  env.MUSIC_ANALYSIS_ENABLED = "1";
  env.MUSIC_AUTO_QUIET_APPROVAL = "1";
  env.MUSIC_ANALYSIS_TOKEN_SHA256 = sha(keys.analyst);
  assert.equal((await invoke("/v1/analysis/claim", "POST", "qa")).status, 401);
  const audio2 = Buffer.alloc(4096, 12);
  const sha2 = sha(audio2);
  const master2 = {
    ...manifest,
    id: "fixture-master-quiet",
    sha256: sha2,
    sourceUrl: "https://licensed.example.test/files/quiet.ogg",
    workKey: "quiet-work",
  };
  assert.equal((await invoke("/v1/masters", "POST", "ingest", master2)).status, 201);
  assert.equal(
    (
      await worker.fetch(
        new Request("https://music.qa.test/v1/masters/fixture-master-quiet/audio", {
          method: "PUT",
          headers: {
            authorization: "Bearer " + keys.ingest,
            "content-type": "audio/ogg",
            "content-length": String(audio2.length),
          },
          body: audio2,
        }),
        env,
      )
    ).status,
    200,
  );
  const quality2 = await invoke("/v1/masters/fixture-master-quiet/quality", "POST", "qa", {
    ...report,
    sha256: sha2,
  });
  assert.equal(quality2.status, 202);
  assert.equal(quality2.result.analysisQueued, true);
  assert.equal(
    (await invoke("/v1/operator/outbox?after=" + cursor, "GET", "operator")).result.items.length,
    0,
    "Quality-only passes must not be supplied as qualified when analysis is enabled",
  );
  const claim = await invoke("/v1/analysis/claim", "POST", "analyst");
  assert.equal(claim.status, 200);
  assert.equal(claim.result.masterSha256, sha2);
  assert.equal(
    (await invoke("/v1/analysis/claim", "POST", "analyst")).result.skipped,
    "no_eligible_jobs",
  );
  const privateAudio = (lease) =>
    worker.fetch(
      new Request("https://music.qa.test/v1/analysis/masters/fixture-master-quiet/audio", {
        headers: { authorization: "Bearer " + keys.analyst, "x-cove-music-analysis-lease": lease },
      }),
      env,
    );
  assert.equal((await privateAudio(crypto.randomUUID())).status, 409);
  assert.equal(
    sha(Buffer.from(await (await privateAudio(claim.result.leaseToken)).arrayBuffer())),
    sha2,
  );
  const report2 = {
    policy: "cove-music-v1",
    sourceSha1: createHash("sha1").update(audio2).digest("hex"),
    sha256: sha2,
    bytes: audio2.length,
    durationSeconds: 180,
    decodedFully: true,
    analyzer: "Synthetic signal and semantics",
    measuredAt: new Date().toISOString(),
    loudness: { integratedLufs: -22, truePeakDbfs: -2, loudnessRangeLu: 3, rmsDynamicRangeDb: 3 },
    signal: {
      spectralCentroidHz: 1000,
      spectralRolloffHz: 2200,
      spectralFlatness: 0.04,
      zeroCrossingRate: 0.03,
      onsetsPerSecond: 0.2,
      tempoBpm: 64,
      tempoConfidence: 0.5,
      tonalEntropy: 0.1,
      abruptTransitionRate: 0.01,
      rhythmicActivity: 0.1,
      energy: 0.1,
    },
    structure: {
      binSeconds: 60,
      timeline: [0, 60, 120].map((start) => ({
        start,
        end: start + 60,
        rmsDbfs: -30,
        centroidHz: 1000,
        onsets: 3,
      })),
      quietSections: [],
      climaxes: [],
      transitionPoints: [],
    },
    semantics: {
      model: "laion/clap-htsat-unfused",
      revision: "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a",
      method: "zero_shot_audio_text_similarity",
      scoreMeaning: "uncalibrated_cosine_similarity",
      sampledSeconds: 24,
      windows: [
        { start: 0, end: 8 },
        { start: 80, end: 88 },
        { start: 170, end: 178 },
      ],
      moods: [],
      nuance: [],
      dimensions: {
        valence: 0.4,
        arousal: 0.1,
        acousticness: 0.8,
        vocalPresence: 0.05,
        ensembleSize: "solo",
        scale: "intimate",
        texture: [],
        instruments: ["piano"],
      },
      confidence: 0.5,
    },
    limitations: ["Synthetic report, not evidence of musical accuracy"],
  };
  assert.equal(
    (
      await invoke("/v1/analysis/jobs/fixture-master-quiet/complete", "POST", "qa", {
        leaseToken: claim.result.leaseToken,
        report: report2,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await invoke("/v1/analysis/jobs/fixture-master-quiet/complete", "POST", "analyst", {
        leaseToken: crypto.randomUUID(),
        report: report2,
      })
    ).status,
    409,
  );
  const finished = await invoke(
    "/v1/analysis/jobs/fixture-master-quiet/complete",
    "POST",
    "analyst",
    {
      leaseToken: claim.result.leaseToken,
      report: report2,
    },
  );
  assert.equal(finished.status, 202, JSON.stringify(finished.result));
  assert.equal(finished.result.status, "approved");
  const approved = await invoke("/v1/operator/outbox?after=" + cursor, "GET", "operator");
  assert.equal(approved.result.items.length, 1);
  assert.equal(approved.result.items[0].master_id, master2.id);
  assert.equal(approved.result.items[0].publishable, 1);
  const analysisCursor = approved.result.nextCursor;
  assert.equal(
    (
      await invoke("/v1/analysis/jobs/fixture-master-quiet/complete", "POST", "analyst", {
        leaseToken: claim.result.leaseToken,
        report: report2,
      })
    ).status,
    409,
    "Completion replay must not create a second outbox grant",
  );
  const catalog2 = await invoke("/v1/operator/preview-catalog?territory=US", "GET", "operator");
  assert.deepEqual(
    catalog2.result.items.map((x) => x.id),
    [master2.id],
  );
  // Real source-scoped admission, lease-bound upload, separate acoustic
  // reviewer and immutable daily operational metrics (all detached MUSIC_DB).
  env.MUSIC_EXECUTION_ENABLED = "1";
  env.MUSIC_MUSIC_REVIEWER_TOKEN_SHA256 = sha(keys.musicReviewer);
  env.MUSIC_AUTO_QUIET_APPROVAL = "0";
  assert.equal((await invoke("/v1/execution/intake/claim", "POST", "qa")).status, 401);
  assert.equal((await invoke("/v1/execution/review", "GET", "ingest")).status, 401);
  const limits = {
    contractId: contract.id,
    paused: false,
    dailyIntake: 1,
    parallelIntake: 1,
    dailyQa: 1,
    parallelQa: 1,
    dailyAnalysis: 1,
    parallelAnalysis: 1,
  };
  assert.equal((await invoke("/v1/execution/source-limits", "POST", "ingest", limits)).status, 401);
  assert.equal(
    (await invoke("/v1/execution/source-limits", "POST", "operator", limits)).status,
    200,
  );
  const audio3 = Buffer.alloc(4096, 11);
  const sha3 = sha(audio3);
  const master3 = {
    ...manifest,
    id: "fixture-master-review",
    sha256: sha3,
    sourceUrl: "https://licensed.example.test/files/review.ogg",
    workKey: "review-work",
  };
  assert.equal((await invoke("/v1/masters", "POST", "ingest", master3)).status, 201);
  const intakeJob = await invoke("/v1/execution/intake/claim", "POST", "ingest", {});
  assert.equal(intakeJob.status, 200);
  assert.equal(intakeJob.result.masterSha256, sha3);
  assert.equal(intakeJob.result.manifest.id, master3.id);
  assert.equal(
    (await invoke("/v1/execution/intake/claim", "POST", "ingest", {})).result.skipped,
    "source_caps_or_no_jobs",
    "Parallel and daily source budgets must fence simultaneous claims",
  );
  const upload3 = (token) =>
    worker.fetch(
      new Request("https://music.qa.test/v1/masters/fixture-master-review/audio", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + keys.ingest,
          "content-type": "audio/ogg",
          "content-length": String(audio3.length),
          ...(token ? { "x-cove-music-intake-lease": token } : {}),
        },
        body: audio3,
      }),
      env,
    );
  assert.equal((await upload3("")).status, 409);
  assert.equal((await upload3(crypto.randomUUID())).status, 409);
  assert.equal((await upload3(intakeJob.result.leaseToken)).status, 200);
  assert.equal((await upload3(intakeJob.result.leaseToken)).status, 409);
  assert.equal(
    (await invoke("/v1/masters/fixture-master-review/quality", "POST", "qa", {
      ...report,
      sha256: sha3,
    })).status,
    409,
    "No full-decode quality attestations may bypass independent lease admission",
  );
  assert.equal(
    (await invoke("/v1/execution/qa/claim", "POST", "ingest", {})).status,
    401,
  );
  const qaLease = await invoke("/v1/execution/qa/claim", "POST", "qa", {});
  assert.equal(qaLease.status, 200);
  assert.equal(qaLease.result.masterId, master3.id);
  assert.equal(
    (await invoke("/v1/execution/qa/claim", "POST", "qa", {})).result.skipped,
    "source_caps_or_no_jobs",
  );
  const privateQa = (lease) => worker.fetch(
    new Request("https://music.qa.test/v1/qa/masters/fixture-master-review/audio", {
      headers: {
        authorization: "Bearer " + keys.qa,
        ...(lease ? { "x-cove-music-qa-lease": lease } : {}),
      },
    }), env,
  );
  assert.equal((await privateQa("")).status, 409);
  assert.equal((await privateQa(crypto.randomUUID())).status, 409);
  assert.equal(sha(Buffer.from(await (await privateQa(qaLease.result.leaseToken)).arrayBuffer())), sha3);
  const qaResponse = await worker.fetch(new Request(
    "https://music.qa.test/v1/masters/fixture-master-review/quality", {
      method: "POST",
      headers: {
        authorization: "Bearer " + keys.qa,
        "content-type": "application/json",
        "x-cove-music-qa-lease": qaLease.result.leaseToken,
      },
      body: JSON.stringify({ ...report, sha256: sha3 }),
    },
  ), env);
  assert.equal(qaResponse.status, 202, await qaResponse.text());
  assert.equal(
    (await invoke("/v1/execution/qa/claim", "POST", "qa", {})).result.skipped,
    "source_caps_or_no_jobs",
  );
  const claim3 = await invoke("/v1/analysis/claim", "POST", "analyst", {});
  assert.equal(claim3.result.masterId, master3.id);
  assert.equal(
    (await invoke("/v1/analysis/claim", "POST", "analyst", {})).result.skipped,
    "no_eligible_jobs",
  );
  const musicReport3 = {
    ...report2,
    sha256: sha3,
    sourceSha1: createHash("sha1").update(audio3).digest("hex"),
    bytes: audio3.length,
  };
  const analyzed3 = await invoke(
    "/v1/analysis/jobs/fixture-master-review/complete",
    "POST",
    "analyst",
    {
      leaseToken: claim3.result.leaseToken,
      report: musicReport3,
      processingMs: 1200,
    },
  );
  assert.equal(analyzed3.status, 202, JSON.stringify(analyzed3.result));
  assert.equal(analyzed3.result.status, "needs_review");
  const pendingReview = await invoke("/v1/execution/review", "GET", "musicReviewer");
  assert.equal(pendingReview.status, 200);
  assert.equal(pendingReview.result.items.length, 1);
  assert.equal(pendingReview.result.items[0].masterId, master3.id);
  const reviewAudio = async (token) =>
    worker.fetch(
      new Request("https://music.qa.test/v1/execution/review/fixture-master-review/audio", {
        headers: { authorization: "Bearer " + keys[token] },
      }),
      env,
    );
  assert.equal((await reviewAudio("qa")).status, 401);
  assert.equal(sha(Buffer.from(await (await reviewAudio("musicReviewer")).arrayBuffer())), sha3);
  const reviewed = {
    masterSha256: sha3,
    reportSha256: pendingReview.result.items[0].reportSha256,
    decision: "approve",
    heardFullMaster: true,
    reviewerId: "fixture-listener-reviewer",
    rationale:
      "Listened to the full original master; calm and non-vocal across the complete recording.",
  };
  assert.equal(
    (await invoke("/v1/execution/review/fixture-master-review", "POST", "analyst", reviewed))
      .status,
    401,
  );
  assert.equal(
    (
      await invoke("/v1/execution/review/fixture-master-review", "POST", "musicReviewer", {
        ...reviewed,
        reportSha256: "0".repeat(64),
      })
    ).status,
    409,
  );
  const humanPass = await invoke(
    "/v1/execution/review/fixture-master-review",
    "POST",
    "musicReviewer",
    reviewed,
  );
  assert.equal(humanPass.status, 202, JSON.stringify(humanPass.result));
  assert.equal(humanPass.result.customerPublished, false);
  assert.equal(
    (await invoke("/v1/execution/review/fixture-master-review", "POST", "musicReviewer", reviewed))
      .status,
    409,
  );
  const queueState = await invoke("/v1/execution/metrics", "GET", "operator");
  assert.equal(queueState.status, 200);
  assert.ok(queueState.result.stages.some((x) => x.stage === "intake_claim" && x.jobs >= 1));
  assert.ok(queueState.result.stages.some((x) => x.stage === "qa_claim" && x.jobs >= 1));
  assert.ok(queueState.result.stages.some((x) => x.stage === "qa_complete" && x.jobs >= 1));
  assert.ok(queueState.result.stages.some((x) => x.stage === "analysis_complete" && x.jobs >= 1));
  assert.ok(queueState.result.stages.some((x) => x.stage === "human_approved" && x.jobs >= 1));
  assert.ok(
    queueState.result.stages.some((x) => x.stage === "analysis_complete" && x.unpriced_jobs >= 1),
  );
  assert.equal((await invoke("/v1/execution/metrics", "GET", "analyst")).status, 401);
  const releasedReview = await invoke(
    "/v1/operator/outbox?after=" + analysisCursor,
    "GET",
    "operator",
  );
  assert.equal(releasedReview.result.items[0].master_id, master3.id);
  const reviewCursor = releasedReview.result.nextCursor;

  assert.equal(
    (
      await invoke("/v1/masters/fixture-master-1/revoke", "POST", "reviewer", {
        reason: "Synthetic recording rights withdrawal",
      })
    ).status,
    200,
  );
  const rescanned = await invoke("/v1/operator/preview-catalog?territory=US", "GET", "operator");
  assert.deepEqual(
    rescanned.result.items.map((x) => x.id),
    [master2.id, master3.id],
    "Revoking one recording must preserve both independently approved masters",
  );
  const removed = await invoke("/v1/operator/outbox?after=" + reviewCursor, "GET", "operator");
  assert.equal(removed.result.items[0].action, "master_revoked");
  const masterCursor = removed.result.nextCursor;
  assert.equal(
    (
      await invoke("/v1/contracts/supplier-1/revoke", "POST", "reviewer", {
        reason: "Synthetic QA contract withdrawn",
      })
    ).status,
    200,
  );
  const withdrawn = await invoke("/v1/operator/outbox?after=" + masterCursor, "GET", "operator");
  assert.equal(withdrawn.result.items[0].action, "contract_revoked");
  const historical = await invoke("/v1/operator/outbox?limit=1", "GET", "operator");
  assert.equal(historical.result.items[0].publishable, 0);
  assert.equal(
    (
      await invoke("/v1/masters", "POST", "ingest", {
        ...manifest,
        id: "fixture-master-2",
        sha256: sha(Buffer.from("different")),
      })
    ).status,
    409,
  );
  assert.equal((await invoke("/v1/operator/outbox?after=abc", "GET", "operator")).status, 400);
  assert.equal((await invoke("/v1/operator/outbox?limit=NaN", "GET", "operator")).status, 400);
  // Primary customer D1, playback rights, and worker route bindings are absent.
  assert.equal(Object.prototype.hasOwnProperty.call(env, "DB"), false);
  console.log(
    "Isolated supply: contract dual review, exact master, QA, ordered outbox, revoked source, and fail-closed gates passed.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
