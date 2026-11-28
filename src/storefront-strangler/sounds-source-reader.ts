import { COVE_SOUNDS_STATIONS } from "../features/fore/cove-sounds-stations";
import { PRODUCTION_LEGAL_PRIMARY } from "./production-disabled-owner-attestation";

import { SOUNDS_SOURCE_ROUTE, SOUNDS_SOURCE_SCHEMA } from "./sounds-source-protocol";
type Statement = {
  bind(...values: unknown[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
};
type Env = {
  PRIMARY_DB: { prepare(sql: string): Statement };
  COVE_RIGHTS_OWNER_PRIMARY_ID?: string;
  COVE_SOUNDS_SOURCE_READER_SECRET?: string;
};
type Row = {
  id: string;
  title: string;
  composer: string;
  performer: string;
  period: string;
  instruments_json: string;
  moods_json: string;
  energy: number | null;
  has_vocals: number | null;
  attribution_text: string;
  source_page_url: string;
  license_statement: string;
  license_url: string;
  territories_json: string;
};
type BookRow = { id: string; title: string; author: string };

/** Private, fixed-query advisory reader. This does not touch the legal DO or
 * accept SQL, table names, titles, user identities, or write commands. The
 * publisher loses its D1 capability while serving-time rights checks remain. */
export async function readSoundsPublicationSource(request: Request, env: Env): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (
    env.COVE_RIGHTS_OWNER_PRIMARY_ID !== PRODUCTION_LEGAL_PRIMARY ||
    !/^[a-f0-9]{64}$/.test(env.COVE_SOUNDS_SOURCE_READER_SECRET || "")
  )
    return new Response(null, { status: 503, headers });
  if (request.headers.get("authorization") !== "Bearer " + env.COVE_SOUNDS_SOURCE_READER_SECRET)
    return new Response(null, { status: 401, headers });
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== SOUNDS_SOURCE_ROUTE ||
    request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
  )
    return new Response(null, { status: 405, headers });
  // Only a two-letter market is accepted. Bound the stream before parsing it.
  const reader = request.body?.getReader();
  let text = "",
    bytes = 0;
  if (!reader) return new Response(null, { status: 400, headers });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (true) {
      const part = await reader.read();
      if (part.done) {
        text += decoder.decode();
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > 128) {
        await reader.cancel();
        return new Response(null, { status: 413, headers });
      }
      text += decoder.decode(part.value, { stream: true });
    }
  } catch {
    return new Response(null, { status: 400, headers });
  } finally {
    reader.releaseLock();
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400, headers });
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).join(",") !== "territory" ||
    typeof (input as { territory?: unknown }).territory !== "string" ||
    !/^[A-Z]{2}$/.test((input as { territory: string }).territory)
  )
    return new Response(null, { status: 400, headers });
  const territory = (input as { territory: string }).territory;
  const titles = [...new Set(COVE_SOUNDS_STATIONS.flatMap((s) => s.books.map((b) => b.title)))];
  try {
    const market = await env.PRIMARY_DB.prepare(
      "SELECT default_currency currency FROM storefront_markets WHERE country_code=? AND market_status='active'",
    )
      .bind(territory)
      .all<{ currency: string }>();
    if (market.results.length !== 1 || !/^[A-Z]{3}$/.test(market.results[0].currency))
      throw Error("Cove Sounds market unavailable: " + territory);
    const [commons, external, editions] = await Promise.all([
      env.PRIMARY_DB.prepare(
        `SELECT id,title,composer,performer,period,instruments_json,moods_json,energy,
           has_vocals,attribution_text,source_page_url,license_statement,license_url,
           allowed_territories_json territories_json
         FROM soundtrack_recordings
         WHERE status='ready' AND quality_status='passed'
           AND storage_key IS NOT NULL AND source_snapshot_key IS NOT NULL
         ORDER BY title,id LIMIT 300`,
      ).all<Row>(),
      env.PRIMARY_DB.prepare(
        `SELECT id,title,composer,performer,period,instruments_json,moods_json,energy,
           has_vocals,attribution_text,source_page_url,license_statement,license_url,territories_json
         FROM soundtrack_external_recordings
         WHERE status='ready' AND storage_key IS NOT NULL ORDER BY title,id LIMIT 300`,
      ).all<Row>(),
      env.PRIMARY_DB.prepare(
        `SELECT p.id, e.title,
           COALESCE((SELECT group_concat(c.name,' ') FROM edition_contributors ec
             JOIN contributors c ON c.id=ec.contributor_id
             WHERE ec.edition_id=e.id AND ec.role='author'),'') author
         FROM editions e JOIN products p ON p.edition_id=e.id
         WHERE p.storefront_status='active' AND p.source_name<>'upload'
           AND e.release_status IN ('available','preorder')
           AND lower(e.title) IN (SELECT lower(value) FROM json_each(?))
         ORDER BY p.id LIMIT 160`,
      )
        .bind(JSON.stringify(titles))
        .all<BookRow>(),
    ]);

    const payload = JSON.stringify({
      schema: SOUNDS_SOURCE_SCHEMA,
      territory,
      currency: market.results[0].currency,
      commons: commons.results,
      external: external.results,
      editions: editions.results,
    });
    if (new TextEncoder().encode(payload).byteLength > 1024 * 1024)
      return new Response(null, { status: 503, headers });
    return new Response(payload, { headers: { ...headers, "content-type": "application/json" } });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
