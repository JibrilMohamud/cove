// Temporary read-only Sounds observation: no D1, no writes, no public media.
const slugs = [
  "gothic-hour",
  "letters-never-sent",
  "beyond-the-old-woods",
  "rainlit-library",
  "the-long-voyage",
  "after-the-last-page",
];
export default {
  async fetch(request, env) {
    const denied = (status) => new Response(null, { status });
    const gate = env.GATE || "";
    const supplied = request.headers.get("authorization") || "";
    if (!/^[a-f0-9]{64}$/.test(gate) || !/^Bearer [a-f0-9]{64}$/.test(supplied)) return denied(401);
    const hash = async (value) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    const [a, b] = await Promise.all([hash(supplied), hash("Bearer " + gate)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    if (diff) return denied(401);
    if (!Number.isSafeInteger(Number(env.EXPIRES)) || Date.now() >= Number(env.EXPIRES))
      return denied(403);
    if (request.method !== "GET" || new URL(request.url).pathname !== "/verify") return denied(404);
    const rows = [];
    for (const slug of slugs) {
      const key = "sounds/v1/US/" + slug + ".json";
      const [object, hot] = await Promise.all([
        env.SOUNDS_PRESENTATION.get(key),
        env.SOUNDS_PRESENTATION_KV.get(key),
      ]);
      if (!object || typeof hot !== "string" || object.size > 96 * 1024) return denied(503);
      const durable = await object.text();
      if (durable !== hot) return denied(503);
      const record = JSON.parse(durable);
      if (
        record.schema !== "cove.sounds.station.v1" ||
        record.territory !== "US" ||
        record.slug !== slug ||
        record.expiresAt <= Date.now() ||
        record.expiresAt >= Date.now() + 90 * 60_000 ||
        !Array.isArray(record.recordings) ||
        record.recordings.length > 8 ||
        !Array.isArray(record.candidateProductIds) ||
        record.candidateProductIds.length > 12 ||
        !record.recordings.every(
          (r) => r.audioUrl === "/api/fore/soundtracks/recordings/" + r.id + "/audio",
        )
      )
        return denied(503);
      rows.push({ slug, recordings: record.recordings.length });
    }
    return Response.json({ rows }, { headers: { "cache-control": "no-store" } });
  },
};
