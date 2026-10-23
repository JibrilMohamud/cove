import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeMusicMaster } from "./music-qa-analyzer.mjs";

const run = promisify(execFile);
const dir = await mkdtemp(path.join(os.tmpdir(), "cove-music-qa-fixture-"));
try {
  const filename = path.join(dir, "synthetic.ogg");
  await run("ffmpeg", [
    "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=210:duration=3", "-af", "volume=0.5",
    "-c:a", "libvorbis", "-y", filename,
  ]);
  const bytes = await readFile(filename);
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const report = await analyzeMusicMaster(filename, { sha1, bytes: bytes.length });
  assert.equal(report.sourceSha1, sha1);
  assert.equal(report.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(report.bytes, bytes.length);
  assert.equal(report.decodedFully, true);
  assert.equal(report.channels, 1);
  assert.ok(report.durationSeconds > 2.5 && report.durationSeconds < 3.5);
  assert.ok(Number.isFinite(report.integratedLufs));
  assert.ok(Number.isFinite(report.truePeakDbfs));
  assert.ok(report.silenceRatio >= 0 && report.silenceRatio <= 1);
  assert.ok(report.clippedSampleRatio >= 0 && report.clippedSampleRatio <= 1);
  await assert.rejects(
    () => analyzeMusicMaster(filename, { sha1: "0".repeat(40), bytes: bytes.length }),
    /master hash changed/,
  );
  await assert.rejects(
    () => analyzeMusicMaster(filename, { sha1, bytes: bytes.length + 1 }),
    /master size/,
  );
  console.log("Full-decode immutable-master music QA passed with synthetic Ogg and tamper rejection.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
