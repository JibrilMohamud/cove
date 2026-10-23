import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-quiet-"));
try {
  await build({
    entryPoints: [
      "src/features/fore/quiet-reading-score.ts",
      "src/features/fore/reading-music-program.ts",
    ],
    outdir: dir,
    outExtension: { ".js": ".mjs" },
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const { assessQuietReading } = await import(path.join(dir, "quiet-reading-score.mjs"));
  const { planDiverseReadingMusic } = await import(path.join(dir, "reading-music-program.mjs"));
  const quiet = {
    durationSeconds: 100,
    signal: {
      energy: 0.2,
      abruptTransitionRate: 0.08,
      onsetsPerSecond: 0.8,
      spectralFlatness: 0.08,
      tonalEntropy: 0.2,
    },
    loudness: { loudnessRangeLu: 8, truePeakDbfs: -2 },
    structure: {
      timeline: [
        { start: 0, end: 25, rmsDbfs: -24 },
        { start: 25, end: 50, rmsDbfs: -23 },
        { start: 50, end: 75, rmsDbfs: -24 },
        { start: 75, end: 100, rmsDbfs: -25 },
      ],
      climaxes: [],
    },
    semantics: {
      sampledSeconds: 30,
      windows: [{ start: 0, end: 10 }, { start: 40, end: 50 }, { start: 90, end: 100 }],
      dimensions: { vocalPresence: 0.05, arousal: 0.1 },
    },
  };
  const a = assessQuietReading(quiet, false);
  assert.equal(a.policy, "cove-quiet-reading-v2");
  assert.equal(a.tier, "quiet_focus");
  assert.equal(a.suitable, true);
  assert.equal(a.vocalEvidence, "instrumental_metadata_and_model");
  const noSemantics = assessQuietReading({ ...quiet, semantics: null }, false);
  assert.equal(noSemantics.suitable, true, "complete instrumental DSP does not require model service");
  assert.equal(noSemantics.evidence, "full_signal_only");
  assert.equal(assessQuietReading({ ...quiet, semantics: null }, null).tier, "needs_vocal_evidence");
  assert.equal(assessQuietReading(quiet, true).tier, "distracting");
  assert.equal(
    assessQuietReading({ ...quiet, semantics: { dimensions: { vocalPresence: 0.75, arousal: 0.1 } } }, false).tier,
    "distracting",
    "semantic vocal detection vetoes inaccurate instrumental tags",
  );
  assert.equal(
    assessQuietReading({ ...quiet, signal: { ...quiet.signal, energy: 0.95 } }, false).tier,
    "distracting",
  );
  assert.equal(
    assessQuietReading({ ...quiet, signal: { ...quiet.signal, abruptTransitionRate: 0.8 } }, false).tier,
    "distracting",
  );
  assert.equal(
    assessQuietReading({ ...quiet, structure: { ...quiet.structure, climaxes: [[0, 70]] } }, false).tier,
    "distracting",
  );
  const tracks = Array.from({ length: 12 }, (_, i) => ({
    id: "r" + i,
    durationSeconds: 600,
    masterFingerprint: "sha" + i,
    composer: "composer" + (i % 4),
    performer: "artist" + i,
    suitability: "quiet_focus",
    affinity: 0.6,
    playsLast30Days: i,
  }));
  tracks.push({ ...tracks[0], id: "duplicate", masterFingerprint: "sha0", affinity: 1 });
  const options = {
    sessionSeed: "book-1:chapter-2:reader-session",
    desiredMinutes: 45,
    recentRecordingIds: ["r0", "r1"],
    recentMasterFingerprints: ["sha0", "sha2"],
  };
  const playlist = planDiverseReadingMusic(tracks, options);
  assert.ok(playlist.length >= 5, "enough new masters for a complete reading session");
  assert.equal(new Set(playlist.map((t) => t.masterFingerprint)).size, playlist.length);
  assert.ok(playlist.every((t) => !["r0", "r1", "r2", "duplicate"].includes(t.id)));
  assert.deepEqual(planDiverseReadingMusic(tracks, options), playlist, "stable within session");
  assert.deepEqual(planDiverseReadingMusic([], options), []);
  assert.ok(
    planDiverseReadingMusic(tracks.slice(0, 2), {
      sessionSeed: "small-pool",
      desiredMinutes: 60,
      recentRecordingIds: ["r0"],
    }).length <= 2,
    "small pools never loop or duplicate to fill the requested time",
  );
  console.log("Automated quiet-reading assessment and playlist diversity passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
