import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";

const run = promisify(execFile);
const DEADLINE_MS = 180000;
export const MAX_MUSIC_QA_BYTES = 25 * 1024 * 1024;

// Audio and waveform are fully decoded on an isolated runner, NOT a customer
// Worker. No bytes are loaded wholly into memory. This never grants rights.
async function decodeSignal(path) {
  const p = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      path,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let message = "";
  p.stderr.on("data", (b) => {
    message = (message + b.toString()).slice(-2000);
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), DEADLINE_MS);
  let carry = Buffer.alloc(0);
  let total = 0,
    clipped = 0,
    frames = 0,
    silent = 0;
  let sumSquares = 0,
    frameSamples = 0;
  try {
    for await (const chunk of p.stdout) {
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const samples = Math.floor(bytes.length / 4);
      for (let i = 0; i < samples; i++) {
        const value = bytes.readFloatLE(i * 4);
        if (!Number.isFinite(value)) throw Error("Nonfinite decoded sample");
        sumSquares += value * value;
        frameSamples++;
        total++;
        if (Math.abs(value) >= 0.999) clipped++;
        if (frameSamples === 8000) {
          if (Math.sqrt(sumSquares / frameSamples) <= 0.00316227766) silent++;
          frames++;
          frameSamples = 0;
          sumSquares = 0;
        }
      }
      carry = bytes.subarray(samples * 4);
    }
    if (carry.length) throw Error("Invalid PCM byte alignment");
    if (frameSamples) {
      if (Math.sqrt(sumSquares / frameSamples) <= 0.00316227766) silent++;
      frames++;
    }
    const status = await new Promise((resolve, reject) => {
      p.on("error", reject);
      p.on("close", resolve);
    });
    if (status !== 0 || total === 0) throw Error("Incomplete audio decoding: " + message);
    return { silenceRatio: silent / frames, clippedSampleRatio: clipped / total };
  } finally {
    clearTimeout(timer);
    p.kill();
  }
}
export async function analyzeMusicMaster(path, expected) {
  const bytes = (await stat(path)).size;
  if (!bytes || bytes > MAX_MUSIC_QA_BYTES || bytes !== expected.bytes)
    throw Error("Unexpected original master size");
  const sha1 = createHash("sha1"),
    sha256 = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    sha1.update(chunk);
    sha256.update(chunk);
  }
  const actualSha1 = sha1.digest("hex");
  if (actualSha1 !== expected.sha1) throw Error("Original master hash changed");
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,sample_rate,channels",
      "-of",
      "json",
      path,
    ],
    { timeout: DEADLINE_MS },
  );
  const metadata = JSON.parse(stdout);
  const streams = (metadata.streams || []).filter((x) => x.codec_type === "audio");
  if (streams.length !== 1) throw Error("Expected exactly one audio stream");
  const durationSeconds = Number(metadata.format?.duration);
  const sampleRate = Number(streams[0].sample_rate);
  const channels = Number(streams[0].channels);
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > 14400 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 2
  )
    throw Error("Invalid decoded audio metadata");
  const { stderr } = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      path,
      "-vn",
      "-af",
      "loudnorm=I=-23:TP=-2:LRA=7:print_format=json",
      "-f",
      "null",
      "-",
    ],
    { timeout: DEADLINE_MS, maxBuffer: 400000 },
  );
  const reports = stderr.match(
    /\{\s*"input_i"\s*:\s*"[^"]+"[\s\S]*?"target_offset"\s*:\s*"[^"]+"\s*\}/g,
  );
  if (!reports?.length) throw Error("Full-file loudness analysis failed");
  const r = JSON.parse(reports.at(-1));
  const integratedLufs = Number(r.input_i);
  const truePeakDbfs = Number(r.input_tp);
  if (![integratedLufs, truePeakDbfs].every(Number.isFinite))
    throw Error("Invalid measured loudness");
  const signal = await decodeSignal(path);
  return {
    sourceSha1: actualSha1,
    sha256: sha256.digest("hex"),
    bytes,
    durationSeconds,
    channels,
    sampleRate,
    integratedLufs,
    truePeakDbfs,
    ...signal,
    decodedFully: true,
    tool: "Cove FFmpeg isolated-full-decode QA v1",
    measuredAt: new Date().toISOString(),
  };
}
