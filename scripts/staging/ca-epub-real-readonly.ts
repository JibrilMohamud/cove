import JSZip from "jszip";

type Env = {
  DB: {
    prepare(sql: string): {
      bind(...values: unknown[]): {
        first<T>(): Promise<T | null>;
      };
    };
  };
  BUCKET: {
    get(key: string): Promise<
      | {
          size: number;
          customMetadata?: Record<string, string>;
          httpMetadata?: { contentType?: string };
          arrayBuffer(): Promise<ArrayBuffer>;
        }
      | null
    >;
  };
  SMOKE_TOKEN?: string;
};

const ids = ["pgca_1010", "pgca_1014", "pgca_1034"];
const policyQuery =
  "SELECT c.id,c.content_hash,c.epub_status,c.ingest_status," +
  " c.rights_status,c.commercial_use_status," +
  " EXISTS(SELECT 1 FROM rights_grants g JOIN products p ON p.edition_id=g.edition_id" +
  " WHERE p.source_external_id=c.id AND g.territory_code='CA' AND g.format='ebook'" +
  " AND g.sales_channel='retail' AND g.status='active' AND g.decision='allow'" +
  " AND (g.starts_at IS NULL OR datetime(g.starts_at)<=datetime('now'))" +
  " AND (g.ends_at IS NULL OR datetime(g.ends_at)>datetime('now'))) ca," +
  " EXISTS(SELECT 1 FROM rights_grants g JOIN products p ON p.edition_id=g.edition_id" +
  " WHERE p.source_external_id=c.id AND g.territory_code='US' AND g.format='ebook'" +
  " AND g.sales_channel='retail' AND g.status='active' AND g.decision='allow'" +
  " AND (g.starts_at IS NULL OR datetime(g.starts_at)<=datetime('now'))" +
  " AND (g.ends_at IS NULL OR datetime(g.ends_at)>datetime('now'))) us" +
  " FROM gutenberg_source_cache c WHERE c.id=? LIMIT 1";

export default {
  async fetch(request: Request, env: Env) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/__isolated-readonly" ||
      !env.SMOKE_TOKEN ||
      env.SMOKE_TOKEN.length < 48 ||
      request.headers.get("x-smoke-token") !== env.SMOKE_TOKEN
    )
      return new Response("Not found", { status: 404 });
    let checked = 0;
    let deniedUS = 0;
    try {
      for (const id of ids) {
        const row = await env.DB.prepare(policyQuery)
          .bind(id)
          .first<{
            id: string;
            content_hash: string;
            epub_status: string;
            ingest_status: string;
            rights_status: string;
            commercial_use_status: string;
            ca: number;
            us: number;
          }>();
        if (
          !row ||
          row.epub_status !== "completed" ||
          row.ingest_status !== "active" ||
          row.rights_status !== "public-domain" ||
          row.commercial_use_status !== "approved" ||
          row.ca !== 1
        )
          throw Error("Stale or unauthorized source rights: " + id);
        if (row.us !== 0) throw Error("Unexpected US grant for CA-restricted book");
        deniedUS++;
        const object = await env.BUCKET.get("epubs/" + id + ".epub");
        if (
          !object ||
          object.size <= 100 ||
          object.size > 8_000_000 ||
          object.customMetadata?.sha256 !== row.content_hash ||
          object.httpMetadata?.contentType !== "application/epub+zip"
        )
          throw Error("R2 canonical object mismatch for " + id);
        const zip = await JSZip.loadAsync(new Uint8Array(await object.arrayBuffer()));
        const mimetype = await zip.file("mimetype")?.async("string");
        const container = await zip.file("META-INF/container.xml")?.async("string");
        const rootFile = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
        const opf = rootFile ? await zip.file(rootFile)?.async("string") : null;
        if (
          mimetype?.trim() !== "application/epub+zip" ||
          !rootFile ||
          !opf ||
          !/<package\b/.test(opf)
        )
          throw Error("Invalid EPUB package manifest for " + id);
        checked++;
      }
      return Response.json({ pass: true, checked, deniedUS });
    } catch (error) {
      // No book bytes, file excerpts or sensitive keys in results.
      return Response.json(
        { pass: false, checked, deniedUS, reason: String(error).slice(0, 120) },
        { status: 422 },
      );
    }
  },
};
