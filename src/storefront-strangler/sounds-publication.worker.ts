/* eslint-disable prettier/prettier -- Schema and safety gates are colocated for reviewer audit; normalize after canary. */
import {
  COVE_SOUNDS_STATIONS, stationRecordings, type CoveSoundsRecording,
} from "../features/fore/cove-sounds-stations";
import { SOUNDS_SOURCE_ROUTE, SOUNDS_SOURCE_SCHEMA } from "./sounds-source-protocol";
import {
  SOUNDS_SCHEMA, soundsKey, validateSoundsSnapshot, type SoundsSnapshot,
} from "../features/fore/cove-sounds-snapshot.server";

type Bucket = { put(key: string, value: string, options: { httpMetadata: { contentType: string } }): Promise<unknown> };
type KV = { put(key: string, value: string, options: { expirationTtl: number }): Promise<unknown> };
type Env = {
  SOUNDS_SOURCE_READER: { fetch(request: Request): Promise<Response> };
  COVE_SOUNDS_SOURCE_READER_SECRET: string;
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
  if (!env.SOUNDS_PRESENTATION || !env.SOUNDS_SOURCE_READER?.fetch ||
      !/^[a-f0-9]{64}$/.test(env.COVE_SOUNDS_SOURCE_READER_SECRET || "")) throw Error("sounds_publication_binding_missing");
  const markets = (env.COVE_SOUNDS_MARKETS || "US").split(",").map((x) => x.trim());
  if (!markets.length || markets.length > 8 || new Set(markets).size !== markets.length ||
      markets.some((x) => !/^[A-Z]{2}$/.test(x))) throw Error("Invalid bounded sounds markets");
  const publication: { territory: string; stations: number; recordings: number; candidates: number }[] = [];
  for (const territory of markets) {
    const response = await env.SOUNDS_SOURCE_READER.fetch(new Request("https://legal-authority.internal" + SOUNDS_SOURCE_ROUTE, {
      method: "POST", headers: { "content-type": "application/json",
        authorization: "Bearer " + env.COVE_SOUNDS_SOURCE_READER_SECRET },
      body: JSON.stringify({ territory }), signal: AbortSignal.timeout(15_000),
    }));
    if (response.status !== 200) throw Error("sounds_publication_source_unavailable");
    const data = await response.json() as { schema?: string; territory?: string; currency?: string;
      commons?: Row[]; external?: Row[]; editions?: BookRow[] };
    if (data.schema !== SOUNDS_SOURCE_SCHEMA || data.territory !== territory ||
        !/^[A-Z]{3}$/.test(data.currency || "") ||
        !Array.isArray(data.commons) || data.commons.length > 300 ||
        !Array.isArray(data.external) || data.external.length > 300 ||
        !Array.isArray(data.editions) || data.editions.length > 160)
      throw Error("sounds_publication_source_invalid");
    const commons = { results: data.commons }, external = { results: data.external },
      editions = { results: data.editions };
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
        currency: data.currency!,
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
