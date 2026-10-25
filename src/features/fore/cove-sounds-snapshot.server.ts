/* eslint-disable prettier/prettier -- Schema and safety gates are colocated for reviewer audit; normalize after canary. */
import type { CoveEnv } from "./api.server";
import { ApiError, json } from "./service";
import { stationBySlug, stationRecordings, type CoveSoundsRecording } from "./cove-sounds-stations";
import { canonicalAuthorizedPreparedFirstPaintBooks } from "./catalog-model.server";

/** A rights-*advisory* document. It can suggest IDs but never authorize a
 * track, customer playback, retail offer, EPUB, or book entitlement.
 * Every hit below is checked against current canonical primary D1 authority. */
export const SOUNDS_SCHEMA = "cove.sounds.station.v1";
const MAX_BYTES = 96 * 1024;
const MAX_AGE = 90 * 60_000;
const MAX_TRACKS = 8;
const MAX_BOOKS = 12;
export type SoundsSnapshot = {
  schema: typeof SOUNDS_SCHEMA;
  territory: string;
  slug: string;
  currency: string;
  generatedAt: number;
  expiresAt: number;
  recordings: CoveSoundsRecording[];
  candidateProductIds: string[];
};
export type PrivateSoundsObjectStore = {
  get(key: string): Promise<{ size: number; text(): Promise<string> } | null>;
};
export type PrivateSoundsKV = {
  get(key: string, options?: { type: "text" }): Promise<string | null>;
};
export function soundsKey(territory: string, slug: string) {
  if (!/^[A-Z]{2}$/.test(territory) || !stationBySlug(slug)) throw Error("Invalid Cove Sounds station key");
  return `sounds/v1/${territory}/${slug}.json`;
}
const idOk = (id: unknown) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/.test(id);
const audioIdOk = (id: unknown) =>
  typeof id === "string" && /^(?:cm_[0-9]{1,15}|ex_[0-9a-f-]{36})$/.test(id);
export function validateSoundsSnapshot(input: unknown, territory: string, slug: string, at = Date.now()): SoundsSnapshot {
  if (!input || typeof input !== "object") throw Error("Missing sounds snapshot");
  const x = input as Partial<SoundsSnapshot>;
  if (
    x.schema !== SOUNDS_SCHEMA ||
    x.territory !== territory || x.slug !== slug ||
    !/^[A-Z]{3}$/.test(x.currency || "") ||
    !Number.isSafeInteger(x.generatedAt) || !Number.isSafeInteger(x.expiresAt) ||
    x.generatedAt! > at + 5000 || at - x.generatedAt! > MAX_AGE ||
    x.expiresAt! <= at || x.expiresAt! > x.generatedAt! + MAX_AGE ||
    !Array.isArray(x.recordings) || x.recordings.length > MAX_TRACKS ||
    !Array.isArray(x.candidateProductIds) || x.candidateProductIds.length > MAX_BOOKS ||
    !x.candidateProductIds.every(idOk) ||
    new Set(x.candidateProductIds).size !== x.candidateProductIds.length ||
    x.recordings.some((r) =>
      !r || !audioIdOk(r.id) || typeof r.title !== "string" || r.title.length > 300 ||
      typeof r.composer !== "string" || typeof r.performer !== "string" ||
      !Array.isArray(r.instruments) || !Array.isArray(r.moods) ||
      r.instruments.length > 20 || r.moods.length > 20 ||
      r.audioUrl !== "/api/fore/soundtracks/recordings/" + r.id + "/audio" ||
      !["https:", "http:"].includes((() => { try { return new URL(r.licenseUrl).protocol; } catch { return ""; } })())
    ) ||
    new Set(x.recordings.map((r) => r.id)).size !== x.recordings.length
  ) throw Error("Invalid or stale Cove Sounds snapshot");
  // Recompute station eligibility even if a compromised producer injects data.
  if (stationRecordings(stationBySlug(slug)!, x.recordings).length !== x.recordings.length)
    throw Error("Unqualified Cove Sounds snapshot tracks");
  return x as SoundsSnapshot;
}
export async function getSoundsSnapshot(
  env: Pick<CoveEnv, "SOUNDS_PRESENTATION" | "SOUNDS_PRESENTATION_KV">,
  territory: string,
  slug: string,
  at = Date.now(),
) {
  if (!env.SOUNDS_PRESENTATION) throw new ApiError(503, "Music discovery is temporarily unavailable.");
  const key = soundsKey(territory, slug);
  // KV is an optional hot read accelerator, not a source of rights authority.
  try {
    const cached = await env.SOUNDS_PRESENTATION_KV?.get(key, { type: "text" });
    if (cached && new TextEncoder().encode(cached).byteLength <= MAX_BYTES) {
      try { return validateSoundsSnapshot(JSON.parse(cached), territory, slug, at); } catch { /* Expired KV is not authority; R2 is consulted next. */ }
    }
  } catch { /* KV propagation is advisory; R2 remains durable. */ }
  let obj;
  try { obj = await env.SOUNDS_PRESENTATION.get(key); }
  catch { throw new ApiError(503, "Music discovery is temporarily unavailable."); }
  if (!obj || obj.size > MAX_BYTES || obj.size < 2)
    throw new ApiError(503, "Music discovery is being refreshed.");
  try { return validateSoundsSnapshot(JSON.parse(await obj.text()), territory, slug, at); }
  catch { throw new ApiError(503, "Music discovery is being refreshed."); }
}
export async function handleSoundsSnapshot(
  request: Request, env: CoveEnv, path: string, territory: string,
): Promise<Response | null> {
  const match = /^\/sounds\/stations\/([a-z0-9-]+)\/(recordings|books)$/.exec(path);
  if (!match) return null;
  if (request.method !== "GET") throw new ApiError(405, "Method not allowed.");
  const [, slug, kind] = match;
  if (!stationBySlug(slug)) throw new ApiError(404, "Listening station not found.");
  // Only specifically seeded markets use this path. A visitor in a different
  // territory retains live canonical catalog discovery, not a stale US list.
  const markets = (env.COVE_SOUNDS_SNAPSHOT_MARKETS || "US").split(",");
  if (env.COVE_SOUNDS_SNAPSHOT_ENABLED !== "1" || !markets.includes(territory))
    return json({ fallback: true, recordings: [], books: [] });
  const snapshot = await getSoundsSnapshot(env, territory, slug);
  if (kind === "recordings") {
    if (!snapshot.recordings.length) return json({ recordings: [], count: 0 });
    const ids = snapshot.recordings.map((r) => r.id);
    // Exactly one bounded, fresh canonical D1 read; KV/R2 never grants
    // playback and existing individual media endpoints check again.
    const check = await env.DB.prepare(
      `WITH candidates AS (SELECT value id FROM json_each(?))
       SELECT r.id FROM candidates c JOIN soundtrack_recordings r ON r.id=c.id
       WHERE r.status='ready' AND r.quality_status='passed'
         AND r.storage_key IS NOT NULL AND r.source_snapshot_key IS NOT NULL
         AND EXISTS (SELECT 1 FROM json_each(
           CASE WHEN json_valid(r.allowed_territories_json) THEN r.allowed_territories_json ELSE '[]' END
         ) WHERE value=? OR value='*')
       UNION ALL
       SELECT e.id FROM candidates c JOIN soundtrack_external_recordings e ON e.id=c.id
       WHERE e.status='ready' AND e.storage_key IS NOT NULL
         AND EXISTS (SELECT 1 FROM json_each(
           CASE WHEN json_valid(e.territories_json) THEN e.territories_json ELSE '[]' END
         ) WHERE value=?)
       LIMIT 8`,
    ).bind(JSON.stringify(ids), territory, territory).all<{ id: string }>();
    const eligible = new Set(check.results.map((r) => r.id));
    const recordings = snapshot.recordings.filter((r) => eligible.has(r.id));
    return json({ recordings, count: recordings.length });
  }
  // Current retail rights and currency are always authoritative. The
  // independent snapshot supplies at most 12 IDs; a single canonical
  // statement supplies freshly authorized display projections.
  const authorized = await canonicalAuthorizedPreparedFirstPaintBooks(
    env.DB, snapshot.candidateProductIds, territory, snapshot.currency, MAX_BOOKS,
  );
  return json({ books: authorized.books, count: authorized.books.length });
}
