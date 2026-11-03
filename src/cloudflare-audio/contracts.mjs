// Pure audio scheduling contract shared by the Cloudflare producer and CI.
const profiles = Object.freeze({
  "/api/fore/internal/ingestion/audio-scan": {
    execution_mode: "direct",
    max_jobs: 0,
    minutes: 4,
    no_discovery: false,
    threads: 2,
  },
  "/api/fore/internal/ingestion/audio-discover": {
    kind: "discover",
    execution_mode: "direct",
    max_jobs: 12,
    minutes: 4,
    no_discovery: true,
    threads: 2,
  },
  "/api/fore/internal/ingestion/audio-track": {
    kind: "track",
    execution_mode: "direct",
    max_jobs: 1,
    minutes: 4,
    no_discovery: true,
    threads: 2,
  },
  "/api/fore/internal/ingestion/audio-align": {
    kind: "align",
    execution_mode: "direct",
    max_jobs: 1,
    minutes: 4,
    no_discovery: true,
    threads: 4,
  },
});

export function payloadForAudioPath(path) {
  if (typeof path !== "string" || !Object.hasOwn(profiles, path)) return null;
  return { ...profiles[path] };
}

export function validAudioMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (
    value.v !== 1 ||
    typeof value.key !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.key)
  )
    return false;
  if (typeof value.path !== "string" || !Object.hasOwn(profiles, value.path)) return false;
  const canonical = profiles[value.path];
  return JSON.stringify(value.request) === JSON.stringify(canonical);
}

export async function audioDispatchKey(path, time = Date.now()) {
  if (!payloadForAudioPath(path) || !Number.isFinite(time) || time < 0) {
    throw Error("Invalid audio dispatch request");
  }
  // The old Vercel Queue producer deduplicated by kind/payload in 5-minute buckets.
  const fiveMinuteBucket = Math.floor(time / 300_000);
  const input = JSON.stringify({ v: 1, path, request: profiles[path], fiveMinuteBucket });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function runtimeEnabled(env) {
  return env?.COVE_AUDIO_QUEUE_ENABLED === "1";
}
