import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "cove-asr-test-"));
try {
  const out = join(directory, "chunks.mjs");
  await build({
    entryPoints: ["src/features/fore/hosted-biosync-chunks.server.ts"],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { hostedBiosyncChunks } = await import(pathToFileURL(out));
  const hash = "a".repeat(64),
    stored = new Map();
  let validLease = true,
    calls = 0,
    invalidWords = false;
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          async first() {
            return sql.startsWith("SELECT language")
              ? {
                  language: "en",
                  tracks_json: JSON.stringify([{ id: "01", sha256: hash, duration: 241 }]),
                }
              : validLease
                ? { id: "job" }
                : null;
          },
        };
      },
    },
    BUCKET: {
      async head(key) {
        return stored.has(key) ? {} : null;
      },
      async get(key) {
        return stored.has(key) ? { json: async () => JSON.parse(stored.get(key)) } : null;
      },
      async put(key, value) {
        stored.set(key, value);
      },
    },
    AI: {
      async run() {
        calls++;
        return {
          words: invalidWords
            ? [{ word: "invalid", start: 3, end: 2 }]
            : Array.from({ length: 20 }, (_, i) => ({
                word: `word${i}`,
                start: i * 2,
                end: i * 2 + 1,
              })),
        };
      },
    },
  };
  const headers = { "x-audio-sha256": hash, "x-cove-job-lease": "lease" };
  const request = (method = "GET", body, extra = {}) =>
    new Request("https://backend/chunks", {
      method,
      headers: { ...headers, ...extra },
      ...(body ? { body } : {}),
    });
  const run = (req, index) => hostedBiosyncChunks(req, env, "pg-1", "01", index);
  const wav = (seconds) => {
    const data = Buffer.alloc(44 + seconds * 32000);
    data.write("RIFF");
    data.writeUInt32LE(data.length - 8, 4);
    data.write("WAVEfmt ", 8);
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20);
    data.writeUInt16LE(1, 22);
    data.writeUInt32LE(16000, 24);
    data.writeUInt32LE(32000, 28);
    data.writeUInt16LE(2, 32);
    data.writeUInt16LE(16, 34);
    data.write("data", 36);
    data.writeUInt32LE(data.length - 44, 40);
    return data;
  };
  const audio = wav(60);
  const pcmHash = Buffer.from(await crypto.subtle.digest("SHA-256", audio)).toString("hex");
  assert.deepEqual((await (await run(request())).json()).missing, [0, 1, 2, 3, 4]);
  assert.equal((await run(request("POST"))).status, 409, "incomplete transcripts cannot finalize");
  validLease = false;
  assert.equal((await run(request("POST", audio), 0)).status, 409);
  assert.equal(calls, 0, "unleased uploads cannot invoke AI");
  validLease = true;
  assert.equal((await run(request("POST", audio, { "x-content-sha256": "wrong" }), 0)).status, 409);
  assert.equal((await run(request("POST", Buffer.alloc(audio.length + 1)), 0)).status, 413);
  invalidWords = true;
  assert.equal((await run(request("POST", audio, { "x-content-sha256": pcmHash }), 0)).status, 503);
  assert.equal(stored.size, 0, "invalid speech timestamps cannot be cached");
  invalidWords = false;
  for (const index of [0, 1, 2, 3])
    assert.equal(
      (await run(request("POST", audio, { "x-content-sha256": pcmHash }), index)).status,
      200,
    );
  const priorCalls = calls;
  assert.equal((await run(request("POST", audio), 0)).status, 200);
  assert.equal(calls, priorCalls, "cached chunks must not repeat inference");
  const final = wav(1);
  env.AI.run = async () => ({ words: [] }); // A silent final interval is valid.
  const finalHash = Buffer.from(await crypto.subtle.digest("SHA-256", final)).toString("hex");
  assert.equal(
    (await run(request("POST", final, { "x-content-sha256": finalHash }), 4)).status,
    200,
  );
  const response = await run(request("POST"));
  assert.equal(response.status, 200);
  const transcript = await response.json();
  assert.equal(transcript.words.length, 80);
  assert.equal(transcript.words[20].start, 60, "second chunk must retain its recording offset");
  assert.ok(transcript.words.every((word) => word.probability === null));
  assert.equal(transcript.identity.audioSha256, hash);
  assert.equal((await (await run(request())).json()).complete, true);
  console.log(
    "PASS: bounded PCM upload, lease/digest checks, R2 resume, exact offsets, and transcript completion",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
