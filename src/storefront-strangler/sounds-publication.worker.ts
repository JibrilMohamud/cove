/* eslint-disable prettier/prettier -- Schema and safety gates are colocated for reviewer audit; normalize after canary. */
import {
  COVE_SOUNDS_STATIONS, stationRecordings, type CoveSoundsRecording,
} from "../features/fore/cove-sounds-stations";
import {
  SOUNDS_SCHEMA, soundsKey, validateSoundsSnapshot, type SoundsSnapshot,
} from "../features/fore/cove-sounds-snapshot.server";

type Statement = {
  bind(...args: unknown[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
};
type D1 = { prepare(sql: string): Statement };
type Bucket = { put(key: string, value: string, options: { httpMetadata: { contentType: string } }): Promise<unknown> };
type KV = { put(key: string, value: string, options: { expirationTtl: number }): Promise<unknown> };
type Env = {
  SOURCE_DB: D1;
  SOUNDS_PRESENTATION: Bucket;
  SOUNDS_PRESENTATION_KV?: KV;
  COVE_SOUNDS_PUBLICATION_ENABLED: string;
  COVE_SOUNDS_MARKETS?: string;
};
const titleKey = (t: string) =>
  t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const parse = (raw: string, max: number) => {
  let x: unknown;
  try { x = JSON.parse(raw); } catch { return []; }
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.length <= 100).slice(0, max) : [];
};
type Row = {
  id: string; title: string; composer: string; performer: string;
  period: string; instruments_json: string; moods_json: string; energy: number | null;
  has_vocals: number | null; attribution_text: string;
  source_page_url: string; license_statement: string; license_url: string;
  territories_json: string;
};
function present(row: Row): CoveSoundsRecording | null {
  if (!/^(?:cm_[0-9]{1,15}|ex_[0-9a-f-]{36})$/.test(row.id)) return null;
  if (!row.title || !row.composer || !row.performer || !row.license_url ||
      !row.attribution_text || !row.source_page_url) return null;
  return {
    id: row.id,
    title: row.title.slice(0, 300),
    composer: row.composer.slice(0, 300),
    performer: row.performer.slice(0, 300),
    period: row.period,
    instruments: parse(row.instruments_json, 20),
    moods: parse(row.moods_json, 20),
    energy: row.energy,
    hasVocals: row.has_vocals === null ? null : !!row.has_vocals,
    attribution: row.attribution_text,
    license: row.license_statement,
    licenseUrl: row.license_url,
    sourcePage: row.source_page_url,
    audioUrl: "/api/fore/soundtracks/recordings/" + row.id + "/audio",
  };
}
type BookRow = { id: string; title: string; author: string };
/** Every SELECT is an advisory producer hint. Authorization stays at serving time. */
export async function publishCoveSounds(env: Env, at = Date.now()) {
  if (env.COVE_SOUNDS_PUBLICATION_ENABLED !== "1") throw Error("sounds_publication_disabled");
  if (!env.SOUNDS_PRESENTATION || !env.SOURCE_DB) throw Error("sounds_publication_binding_missing");
  const markets = (env.COVE_SOUNDS_MARKETS || "US").split(",").map((x) => x.trim());
  if (!markets.length || markets.length > 8 || new Set(markets).size !== markets.length ||
      markets.some((x) => !/^[A-Z]{2}$/.test(x))) throw Error("Invalid bounded sounds markets");
  const titles = [...new Set(COVE_SOUNDS_STATIONS.flatMap((s) => s.books.map((b) => b.title)))];
  const publication: { territory: string; stations: number; recordings: number; candidates: number }[] = [];
  for (const territory of markets) {
    const market = await env.SOURCE_DB.prepare(
      "SELECT default_currency currency FROM storefront_markets WHERE country_code=? AND market_status='active'",
    ).bind(territory).all<{ currency: string }>();
    if (market.results.length !== 1 || !/^[A-Z]{3}$/.test(market.results[0].currency))
      throw Error("Cove Sounds market unavailable: " + territory);
    const [commons, external, editions] = await Promise.all([
      env.SOURCE_DB.prepare(
        `SELECT id,title,composer,performer,period,instruments_json,moods_json,energy,
           has_vocals,attribution_text,source_page_url,license_statement,license_url,
           allowed_territories_json territories_json
         FROM soundtrack_recordings
         WHERE status='ready' AND quality_status='passed'
           AND storage_key IS NOT NULL AND source_snapshot_key IS NOT NULL
         ORDER BY title,id LIMIT 300`,
      ).all<Row>(),
      env.SOURCE_DB.prepare(
        `SELECT id,title,composer,performer,period,instruments_json,moods_json,energy,
           has_vocals,attribution_text,source_page_url,license_statement,license_url,territories_json
         FROM soundtrack_external_recordings
         WHERE status='ready' AND storage_key IS NOT NULL ORDER BY title,id LIMIT 300`,
      ).all<Row>(),
      env.SOURCE_DB.prepare(
        `SELECT p.id, e.title,
           COALESCE((SELECT group_concat(c.name,' ') FROM edition_contributors ec
             JOIN contributors c ON c.id=ec.contributor_id
             WHERE ec.edition_id=e.id AND ec.role='author'),'') author
         FROM editions e JOIN products p ON p.edition_id=e.id
         WHERE p.storefront_status='active' AND p.source_name<>'upload'
           AND e.release_status IN ('available','preorder')
           AND lower(e.title) IN (SELECT lower(value) FROM json_each(?))
         ORDER BY p.id LIMIT 160`,
      ).bind(JSON.stringify(titles)).all<BookRow>(),
    ]);
    const recordings = [...commons.results, ...external.results]
      .filter((row) => parse(row.territories_json, 100).some((x) => x === territory || (x === "*" && row.id.startsWith("cm_"))))
      .map(present).filter((row): row is CoveSoundsRecording => row !== null);
    let count = 0, candidates = 0;
    const validated: { key: string; json: string }[] = [];
    for (const station of COVE_SOUNDS_STATIONS) {
      const matched = station.books.flatMap((seed) => editions.results
        .filter((b) => titleKey(b.title) === titleKey(seed.title) &&
          titleKey(b.author).split(" ").includes(titleKey(seed.author).split(" ").at(-1) || ""))
        .slice(0, 2).map((b) => b.id));
      const document: SoundsSnapshot = {
        schema: SOUNDS_SCHEMA,
        territory,
        slug: station.slug,
        currency: market.results[0].currency,
        generatedAt: at,
        expiresAt: at + 75 * 60_000,
        recordings: stationRecordings(station, recordings),
        candidateProductIds: [...new Set(matched)].slice(0, 12),
      };
      validateSoundsSnapshot(document, territory, station.slug, at);
      const json = JSON.stringify(document);
      if (new TextEncoder().encode(json).byteLength > 96 * 1024)
        throw Error("Oversized Cove Sounds publication");
      validated.push({ key: soundsKey(territory, station.slug), json });
      count += document.recordings.length; candidates += document.candidateProductIds.length;
    }
    // New territories must not be activated as six empty discovery stations.
    // "Ready" here only describes advisory publication; playback and retail
    // still require live per-request canonical legal authorization.
    if (territory !== "US" && validated.some(({ json }) => {
      const station = JSON.parse(json) as SoundsSnapshot;
      return station.recordings.length === 0 || station.candidateProductIds.length === 0;
    })) {
      throw Error("Cove Sounds territory not publication-ready: " + territory);
    }
    // Each object is a complete, validated publication. Write durable private
    // R2 FIRST, then optional KV hot replica. A partial cron never grants rights.
    for (const { key, json } of validated) {
      await env.SOUNDS_PRESENTATION.put(key, json, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      if (env.SOUNDS_PRESENTATION_KV)
        await env.SOUNDS_PRESENTATION_KV.put(key, json, { expirationTtl: 3600 });
    }
    publication.push({ territory, stations: validated.length, recordings: count, candidates });
  }
  return publication;
}
export default {
  async fetch(): Promise<Response> { return new Response(null, { status: 404 }); },
  scheduled(_controller: unknown, env: Env, ctx: { waitUntil(work: Promise<unknown>): void }) {
    ctx.waitUntil(publishCoveSounds(env).then((publication) =>
      console.info(JSON.stringify({ event: "sounds_publication", publication })),
    ));
  },
};
