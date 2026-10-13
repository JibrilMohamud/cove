import type { CoveEnv } from "./api.server";

type Env = Pick<CoveEnv, "DB" | "BUCKET"> & {
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
};
type Word = { text: string; start: number; end: number; probability: null };
type Chunk = {
  leaseToken: string;
  audioSha256: string;
  pcmSha256: string;
  index: number;
  offset: number;
  duration: number;
  words: Word[];
};
const CHUNK_SECONDS = 120;
const MAX_BYTES = CHUNK_SECONDS * 16000 * 2 + 44;
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function boundedAudio(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const blocks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      blocks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const audio = new Uint8Array(size);
  let cursor = 0;
  for (const block of blocks) {
    audio.set(block, cursor);
    cursor += block.length;
  }
  return audio;
}

/** Fixed PCM intervals, pinned to a prepared recording and an active D1 lease.
 * Only the trusted audio worker decodes the SHA-256-verified original. The
 * backend stores actual ASR results; exact EPUB matching remains mandatory.
 */
export async function hostedBiosyncChunks(
  request: Request,
  env: Env,
  editionId: string,
  trackId: string,
  chunkIndex?: number,
): Promise<Response> {
  if (!env.AI || !env.BUCKET) return reply({ error: "Hosted ASR unavailable." }, 503);
  const row = await env.DB.prepare("SELECT language,tracks_json FROM audio_editions WHERE id=?")
    .bind(editionId)
    .first<{ language: string; tracks_json: string }>();
  const tracks: Array<{ id: string; sha256?: string; duration?: number }> = row
    ? JSON.parse(row.tracks_json)
    : [];
  const track = tracks.find((item) => item.id === trackId);
  const hash = track?.sha256 || "";
  const duration = Number(track?.duration || 0);
  if (
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 43200
  )
    return reply({ error: "Prepared recording duration or digest is invalid." }, 409);
  if (request.headers.get("x-audio-sha256") !== hash)
    return reply({ error: "Prepared recording changed." }, 409);
  const count = Math.ceil(duration / CHUNK_SECONDS);
  const prefix = `biosync/transcripts/cloudflare-whisper-chunks-v1/${hash}/`;
  const key = (index: number) => `${prefix}${index}.json`;
  const fullKey = `biosync/transcripts/cloudflare-whisper-v1/${hash}.json`;
  const identity = { audioSha256: hash, model: "cloudflare-whisper-v1", language: row?.language };

  if (chunkIndex === undefined && request.method === "GET") {
    const complete = await env.BUCKET.get(fullKey);
    if (complete) return reply({ complete: true, transcript: await complete.json() });
    const missing: number[] = [];
    // At most 360 small metadata reads, bounded by the accepted duration.
    for (let index = 0; index < count; index++) {
      if (!(await env.BUCKET.head?.(key(index)))) missing.push(index);
    }
    return reply({
      complete: false,
      identity,
      duration,
      chunkSeconds: CHUNK_SECONDS,
      count,
      missing,
    });
  }
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  const lease = await env.DB.prepare(
    "SELECT id FROM audio_jobs WHERE kind='align' AND status='running' AND lease_token=? AND lease_until>? " +
      "AND json_extract(payload_json,'$.editionId')=? AND json_extract(payload_json,'$.trackId')=? " +
      "AND json_extract(payload_json,'$.audioSha256')=?",
  )
    .bind(
      request.headers.get("x-cove-job-lease") || "",
      new Date().toISOString(),
      editionId,
      trackId,
      hash,
    )
    .first();
  if (!lease) return reply({ error: "An active recording alignment lease is required." }, 409);

  if (chunkIndex !== undefined) {
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= count)
      return reply({ error: "Invalid chunk index." }, 400);
    const cached = await env.BUCKET.get(key(chunkIndex));
    if (cached) return reply({ cached: true, index: chunkIndex });
    const audio = await boundedAudio(request);
    if (!audio || audio.length < 46)
      return reply({ error: "PCM chunk exceeds its byte limit." }, 413);
    const view = new DataView(audio.buffer);
    const label = (start: number, length: number) =>
      new TextDecoder().decode(audio.slice(start, start + length));
    const chunkDuration = Math.min(CHUNK_SECONDS, duration - chunkIndex * CHUNK_SECONDS);
    if (
      label(0, 4) !== "RIFF" ||
      label(8, 8) !== "WAVEfmt " ||
      label(36, 4) !== "data" ||
      view.getUint32(4, true) !== audio.length - 8 ||
      view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 ||
      view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== 16000 ||
      view.getUint32(28, true) !== 32000 ||
      view.getUint16(32, true) !== 2 ||
      view.getUint16(34, true) !== 16 ||
      view.getUint32(40, true) !== audio.length - 44 ||
      (audio.length - 44) % 2 !== 0 ||
      Math.abs((audio.length - 44) / 32000 - chunkDuration) > 0.01
    )
      return reply({ error: "Expected fixed-length mono 16-kHz PCM WAV." }, 400);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", audio))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (digest !== request.headers.get("x-content-sha256"))
      return reply({ error: "PCM chunk digest mismatch." }, 409);
    let result: { words?: Array<{ word: string; start: number; end: number }> };
    try {
      result = (await env.AI.run("@cf/openai/whisper", {
        audio: Array.from(audio),
      })) as typeof result;
    } catch {
      return reply({ error: "Chunk speech recognition unavailable.", retryable: true }, 503);
    }
    if (!Array.isArray(result?.words)) return reply({ error: "Word timestamps unavailable." }, 503);
    const words: Word[] = [];
    for (const word of result.words) {
      if (
        !word ||
        typeof word.word !== "string" ||
        !word.word.trim() ||
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < 0 ||
        word.end <= word.start ||
        word.end > chunkDuration ||
        (words.length > 0 && word.start < words[words.length - 1].end)
      )
        return reply({ error: "Speech engine returned invalid or overlapping timestamps." }, 503);
      words.push({ text: word.word.trim(), start: word.start, end: word.end, probability: null });
    }
    const chunk: Chunk = {
      leaseToken: request.headers.get("x-cove-job-lease") || "",
      audioSha256: hash,
      pcmSha256: digest,
      index: chunkIndex,
      offset: chunkIndex * CHUNK_SECONDS,
      duration: chunkDuration,
      words,
    };
    await env.BUCKET.put(key(chunkIndex), JSON.stringify(chunk), {
      httpMetadata: { contentType: "application/json" },
    });
    return reply({ cached: false, index: chunkIndex, timedWords: words.length });
  }

  const words: Word[] = [];
  for (let index = 0; index < count; index++) {
    const object = await env.BUCKET.get(key(index));
    if (!object) return reply({ error: "Transcription is incomplete.", missing: index }, 409);
    const chunk: Chunk = await object.json();
    if (
      chunk.audioSha256 !== hash ||
      chunk.index !== index ||
      chunk.offset !== index * CHUNK_SECONDS ||
      chunk.duration !== Math.min(CHUNK_SECONDS, duration - chunk.offset) ||
      !Array.isArray(chunk.words)
    )
      return reply({ error: "Cached transcription identity mismatch." }, 409);
    for (const word of chunk.words) {
      const start = word.start + chunk.offset,
        end = word.end + chunk.offset;
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        word.start < 0 ||
        word.end > chunk.duration ||
        end <= start ||
        word.probability !== null ||
        (words.length > 0 && start < words[words.length - 1].end)
      )
        return reply({ error: "Cached word timestamps are invalid." }, 409);
      words.push({ ...word, start, end });
    }
    if (words.length > 120000) return reply({ error: "Transcript exceeds the word limit." }, 413);
  }
  if (words.length < 30) return reply({ error: "Too few independently transcribed words." }, 422);
  const transcript = {
    identity,
    engine: "cloudflare-workers-ai-whisper",
    confidenceMode: "unreported",
    language: row?.language,
    duration,
    words,
  };
  await env.BUCKET.put(fullKey, JSON.stringify(transcript), {
    httpMetadata: { contentType: "application/json" },
  });
  return reply(transcript);
}
