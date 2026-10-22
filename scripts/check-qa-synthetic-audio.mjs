import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

// Runs entirely in a disposable local DB/R2 domain. No Stripe, production D1,
// customer identities, publisher media or external audio recordings are used.
function originalWave() {
  const sampleRate = 8000;
  const samples = 4000;
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const taper = Math.min(1, i / 400, (samples - i) / 400);
    const value = Math.round(
      3500 * Math.max(0, taper) * Math.sin((i * 2 * Math.PI * 440) / sampleRate),
    );
    out.writeInt16LE(value, 44 + i * 2);
  }
  return out;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-original-audio-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  const moduleFile = path.join(root, "commercial-audio-fixture.mjs");
  const original = fs.readFileSync("src/features/fore/commercial-audio.server.ts", "utf8");
  // Expose an otherwise private storage primitive exclusively inside the
  // throwaway test bundle. The real production module is never modified.
  await build({
    stdin: {
      contents: original + "\nexport { serveStoredAudio };\n",
      sourcefile: "commercial-audio-qa.ts",
      resolveDir: path.resolve("src/features/fore"),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: moduleFile,
    logLevel: "silent",
  });
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "api.mjs"),
    logLevel: "silent",
  });
  const audio = await import(moduleFile);
  const api = await import(path.join(root, "api.mjs"));
  const env = localBindings(root);
  await api.handleCoveApi(new Request("https://cove.qa/api/fore/catalog"), env);
  const product = await env.DB.prepare(
    "SELECT id FROM products WHERE source_external_id='1342'",
  ).first();
  assert.ok(product, "fixture must seed a known local catalog product");
  const userId = "qa_original_audio_" + randomUUID();
  const otherId = "qa_other_reader_" + randomUUID();
  const objectKey = "qa/synthetic/original-tone.wav";
  const bytes = originalWave();
  await env.BUCKET.put(objectKey, bytes);
  const asset = {
    object_key: objectKey,
    mime_type: "audio/wav",
    size_bytes: bytes.length,
  };
  const route = "https://cove.qa/api/fore/audio/qa-original/tracks/intro";
  async function protectedRead(user, range) {
    if (!(await audio.hasAudioAccess(env.DB, user, product.id, "US"))) {
      throw Error("protected_audio_access_denied");
    }
    await audio.assertCommercialAudioRiskAccess(env.DB, user, product.id);
    return audio.serveStoredAudio(
      new Request(route, { headers: range ? { range } : undefined }),
      env,
      asset,
      "private, no-store",
    );
  }
  await assert.rejects(protectedRead(userId), /protected_audio_access_denied/);
  await assert.rejects(protectedRead(otherId), /protected_audio_access_denied/);
  const stamp = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at) VALUES(?,?,?,'purchase','active','qa-original-fixture',?,?)",
  )
    .bind("ent_qa_" + randomUUID(), userId, product.id, stamp, stamp)
    .run();
  assert.equal(await audio.hasAudioAccess(env.DB, userId, product.id, "US"), true);
  assert.equal(await audio.hasAudioAccess(env.DB, otherId, product.id, "US"), false);
  const streamed = await protectedRead(userId);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get("content-type"), "audio/wav");
  assert.equal(streamed.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await streamed.arrayBuffer()), bytes);
  const partial = await protectedRead(userId, "bytes=0-63");
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 0-63/${bytes.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 64));
  await assert.rejects(protectedRead(otherId), /protected_audio_access_denied/);
  await env.DB.prepare("UPDATE entitlements SET status='revoked',updated_at=? WHERE user_id=?")
    .bind(new Date().toISOString(), userId)
    .run();
  await assert.rejects(protectedRead(userId), /protected_audio_access_denied/);
  console.log(
    "PASS: original PCM audio, private R2 bytes/ranges, entitlement denial, granted-only streaming and revocation (component-level fixture).",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
