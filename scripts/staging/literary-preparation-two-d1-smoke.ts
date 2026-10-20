import JSZip from "jszip";
import {
  enqueueIsolatedLiteraryPreparation,
  runIsolatedLiteraryPreparationTick,
} from "../../src/lib/literary-preparation-domain.server";
import type { CoveEnv } from "../../src/features/fore/api.server";

type Env = { DB: CoveEnv["DB"]; CONTENT_DB: CoveEnv["DB"]; BUCKET: CoveEnv["BUCKET"]; SMOKE_TOKEN?: string };
const source = "pgau_prep_smoke_20261020";
const product = "prod_prep_smoke_20261020";
const edition = "ed_prep_smoke_20261020";
const grant = "rg_prep_smoke_20261020";
const sha = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

export default {
  async fetch(request: Request, env: Env) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/__isolated-preparation-smoke" ||
      !env.SMOKE_TOKEN ||
      env.SMOKE_TOKEN.length < 48 ||
      request.headers.get("x-smoke-token") !== env.SMOKE_TOKEN
    ) return new Response("Not found", { status: 404 });
    let jobId: string | null = null;
    try {
      const zip = new JSZip();
      zip.file("mimetype", "application/epub+zip");
      zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
      zip.file("book.opf", '<package><manifest><item id="chapter" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
      zip.file("a.xhtml", "<html><body><h1>Staging</h1>" + "The lake was calm. ".repeat(200) + "</body></html>");
      const bytes = await zip.generateAsync({ type: "uint8array" });
      const hash = await sha(bytes);
      // Synthetic isolated staging fixture; NOT a production source or book.
      await env.DB.prepare("INSERT OR IGNORE INTO editions(id) VALUES(?)").bind(edition).run();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO gutenberg_source_cache(id,source_id,ingest_status,epub_status,rights_status,commercial_use_status,content_hash,formats_json,rights_territories_json) VALUES(?,'pg_au','active','completed','public-domain','approved',?,'{}','[\"AU\"]')",
      ).bind(source, hash).run();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO products(id,edition_id,source_name,source_external_id,format,storefront_status) VALUES(?,?,'gutenberg',?,'ebook','active')",
      ).bind(product, edition, source).run();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO rights_grants(id,edition_id,territory_code,format,sales_channel,status,decision,source) VALUES(?,?,'AU','ebook','retail','active','allow','gutenberg-pg_au-public-domain')",
      ).bind(grant, edition).run();
      await env.BUCKET!.put("epubs/" + source + ".epub", bytes, {
        customMetadata: { sha256: hash },
        httpMetadata: { contentType: "application/epub+zip" },
      });
      const role = {
        ...env,
        FORE_CONTENT_PROCESSOR_ENABLED: "1",
        FORE_CONTENT_PREPARE_ENABLED: "1",
        FORE_CONTENT_PROCESSOR_ROLE: "literary-prepare",
      };
      const enq = await enqueueIsolatedLiteraryPreparation(role, product, edition);
      if (!("enqueued" in enq) || !enq.enqueued) throw Error("Not enqueued");
      jobId = enq.enqueued;
      const result = await runIsolatedLiteraryPreparationTick(role);
      const row = await env.CONTENT_DB.prepare(
        "SELECT status,result_key,result_sha256 FROM literary_prepare_jobs WHERE id=?",
      ).bind(jobId).first<{ status: string; result_key: string; result_sha256: string }>();
      const obj = row?.result_key ? await env.BUCKET!.get(row.result_key) : null;
      const json = obj ? JSON.parse(await obj.text()) : null;
      await env.DB.prepare("UPDATE rights_grants SET status='revoked' WHERE id=?")
        .bind(grant).run();
      const revoked = await enqueueIsolatedLiteraryPreparation(role, product, edition);
      const ok =
        row?.status === "done" && result.prepared === jobId &&
        typeof row.result_sha256 === "string" &&
        row.result_sha256 === obj?.customMetadata?.sha256 &&
        json?.sourceSha256 === hash &&
        json?.selected?.length > 0 &&
        "skipped" in revoked && revoked.skipped === "source_or_rights_ineligible";
      return Response.json({ pass: ok, prepared: !!result.prepared, sections: json?.totalSections, revokedRejected: "skipped" in revoked }, { status: ok ? 200 : 409 });
    } catch (error) {
      return Response.json({ pass: false, reason: String(error).slice(0, 180) }, { status: 422 });
    } finally {
      // Stage cleanup occurs in-worker even if a test assertion fails.
      await env.BUCKET!.delete("epubs/" + source + ".epub").catch(() => {});
      if (jobId) {
        await env.BUCKET!.delete("literary/isolated-prepared-v1/" + jobId + ".json").catch(() => {});
        await env.CONTENT_DB.prepare("DELETE FROM literary_prepare_jobs WHERE id=?").bind(jobId).run().catch(() => {});
      }
      await env.DB.prepare("DELETE FROM rights_grants WHERE id=?").bind(grant).run().catch(() => {});
      await env.DB.prepare("DELETE FROM products WHERE id=?").bind(product).run().catch(() => {});
      await env.DB.prepare("DELETE FROM gutenberg_source_cache WHERE id=?").bind(source).run().catch(() => {});
      await env.DB.prepare("DELETE FROM editions WHERE id=?").bind(edition).run().catch(() => {});
    }
  },
};
