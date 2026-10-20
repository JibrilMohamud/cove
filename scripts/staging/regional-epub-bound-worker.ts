import { repairRegionalEpubAssets } from "../../src/features/fore/regional-epub-asset-repair.server";

type Env = {
  DB: {
    prepare(sql: string): {
      bind(...args: unknown[]): {
        first<T>(): Promise<T | null>;
        all<T>(): Promise<{ results: T[] }>;
        run(): Promise<unknown>;
      };
    };
  };
  BUCKET: {
    put(key: string, content: Uint8Array, metadata: Record<string, unknown>): Promise<unknown>;
    head(key: string): Promise<any>;
    delete(key: string): Promise<void>;
  };
  SMOKE_TOKEN: string;
};

export default {
  async fetch(request: Request, env: Env) {
    const token = request.headers.get("x-smoke-token") || "";
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/__isolated-smoke" ||
      token.length < 48 ||
      token !== env.SMOKE_TOKEN
    )
      return new Response("Not found", { status: 404 });

    const sourceId = "pgau_stage_good";
    const key = "epubs/" + sourceId + ".epub";
    const stageHash = "goodhash";
    try {
      // Test-only storage object; the helper's security gate verifies the
      // exact private R2 HEAD SHA and content type, not the EPUB bytes.
      await env.BUCKET.put(key, new TextEncoder().encode("ISOLATED-EPUB-METADATA-SMOKE"), {
        httpMetadata: { contentType: "application/epub+zip" },
        customMetadata: { sha256: stageHash, source: "pg_au" },
      });
      const check = await env.BUCKET.head(key);
      if (
        check?.customMetadata?.sha256 !== stageHash ||
        check?.httpMetadata?.contentType !== "application/epub+zip"
      ) throw new Error("Staging R2 metadata was not persisted correctly");

      const repaired = await repairRegionalEpubAssets(env, { limit: 8 });
      const row = await env.DB.prepare(
        "SELECT v.object_key,v.sha256 FROM digital_assets a JOIN asset_versions v ON v.id=a.current_version_id WHERE a.edition_id=? AND a.kind='epub'",
      ).bind("ed_pgau_stage_good").first<{object_key:string;sha256:string}>();
      const forbidden = await env.DB.prepare(
        "SELECT COUNT(*) n FROM digital_assets WHERE edition_id=?",
      ).bind("ed_pgau_stage_withdrawn").first<{n:number}>();
      const deniedObject = await env.DB.prepare(
        "SELECT COUNT(*) n FROM digital_assets WHERE edition_id=?",
      ).bind("ed_pgau_stage_missing").first<{n:number}>();
      const retry = await repairRegionalEpubAssets(env, { limit: 8 });
      const verified =
        repaired.repaired === 1 &&
        repaired.missingOrMismatched === 1 &&
        row?.object_key === key &&
        row?.sha256 === stageHash &&
        forbidden?.n === 0 &&
        deniedObject?.n === 0 &&
        retry.repaired === 0;
      return Response.json(
        { success: verified, repaired, retry, row, forbidden: forbidden?.n, missing: deniedObject?.n },
        { status: verified ? 200 : 409 },
      );
    } catch (e) {
      return Response.json({ success: false, message: String(e).slice(0, 200) }, { status: 503 });
    } finally {
      // The smoke Worker cleans up its temporary R2 metadata object.
      await env.BUCKET.delete(key);
    }
  },
};
