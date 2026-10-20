import {
  seedLiteraryPreparationHandoff,
  dispatchOneLiteraryPreparationHandoff,
} from "../../src/lib/literary-prepare-outbox.server";
import type { CoveEnv } from "../../src/features/fore/api.server";

type Env = {
  DB: CoveEnv["DB"];
  CONTENT_DB: CoveEnv["DB"];
  BUCKET: CoveEnv["BUCKET"];
  SMOKE_TOKEN?: string;
};
const cases = [
  { id: "a", product: "prod_outbox_a_20261020", edition: "ed_outbox_a_20261020",
    source: "pgau_outbox_a_20261020", grant: "rg_outbox_a_20261020", hash: "a".repeat(64) },
  { id: "b", product: "prod_outbox_b_20261020", edition: "ed_outbox_b_20261020",
    source: "pgau_outbox_b_20261020", grant: "rg_outbox_b_20261020", hash: "b".repeat(64) },
];
const expected = async (b: (typeof cases)[number]) => {
  const material = new TextEncoder().encode(
    [b.product, b.edition, b.source, b.hash].join(":"),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", material))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
};

export default {
  async fetch(request: Request, env: Env) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/__isolated-handoff-smoke" ||
      !env.SMOKE_TOKEN ||
      env.SMOKE_TOKEN.length < 48 ||
      request.headers.get("x-smoke-token") !== env.SMOKE_TOKEN
    ) return new Response("Not found", { status: 404 });
    const role = {
      ...env,
      FORE_CONTENT_PROCESSOR_ENABLED: "1",
      FORE_CONTENT_PREPARE_ENABLED: "1",
      FORE_CONTENT_HANDOFF_ENABLED: "1",
      FORE_CONTENT_PROCESSOR_ROLE: "literary-handoff",
    };
    try {
      for (const b of cases) {
        await env.DB.prepare("INSERT OR IGNORE INTO editions(id) VALUES(?)")
          .bind(b.edition).run();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO gutenberg_source_cache(id,source_id,ingest_status,epub_status,rights_status,commercial_use_status,content_hash,formats_json,rights_territories_json) VALUES(?,'pg_au','active','completed','public-domain','approved',?,'{}','[\"AU\"]')",
        ).bind(b.source, b.hash).run();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO products(id,edition_id,source_name,source_external_id,format,storefront_status) VALUES(?,?,'gutenberg',?,'ebook','active')",
        ).bind(b.product, b.edition, b.source).run();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO rights_grants(id,edition_id,territory_code,format,sales_channel,status,decision,source) VALUES(?,?,'AU','ebook','retail','active','allow','gutenberg-pg_au-public-domain')",
        ).bind(b.grant, b.edition).run();
      }
      const [a, b] = cases;
      const one = await seedLiteraryPreparationHandoff(role, a.product, a.edition);
      const duplicate = await seedLiteraryPreparationHandoff(role, a.product, a.edition);
      const deliver = await dispatchOneLiteraryPreparationHandoff(role);
      const aId = await expected(a);
      // Simulate ACK loss on primary after successful secondary enqueue:
      // redelivery must NOT create another preparation job.
      await env.DB.prepare(
        "UPDATE literary_prepare_outbox SET status='queued',attempts=0,available_at='2020-01-01' WHERE id=?",
      ).bind(aId).run();
      const replay = await dispatchOneLiteraryPreparationHandoff(role);
      const bIntent = await seedLiteraryPreparationHandoff(role, b.product, b.edition);
      await env.DB.prepare("UPDATE rights_grants SET status='revoked' WHERE id=?")
        .bind(b.grant).run();
      const cancelled = await dispatchOneLiteraryPreparationHandoff(role);
      const snapshot = await env.DB.prepare(
        "SELECT COUNT(*) n FROM literary_prepare_outbox WHERE id IN (?,?)",
      ).bind(aId, await expected(b)).first<{ n: number }>();
      const independent = await env.CONTENT_DB.prepare(
        "SELECT COUNT(*) n FROM literary_prepare_jobs WHERE id IN (?,?)",
      ).bind(aId, await expected(b)).first<{ n: number }>();
      const pass =
        "outboxId" in one && one.outboxId === aId &&
        "duplicate" in duplicate && duplicate.duplicate === true &&
        deliver.delivered === aId && replay.delivered === aId &&
        "outboxId" in bIntent && cancelled.cancelled === bIntent.outboxId &&
        snapshot?.n === 2 && independent?.n === 1;
      return Response.json({
        pass, duplicateAcknowledged: duplicate.duplicate,
        replayDeduplicated: independent?.n === 1,
        revokedCancelled: cancelled.cancelled === bIntent.outboxId,
        independentJobs: independent?.n,
      }, { status: pass ? 200 : 409 });
    } catch (e) {
      return Response.json({ pass: false, reason: String(e).slice(0, 180) }, { status: 422 });
    } finally {
      for (const b of cases) {
        const id = await expected(b);
        await env.CONTENT_DB.prepare("DELETE FROM literary_prepare_jobs WHERE id=?")
          .bind(id).run().catch(() => {});
        await env.DB.prepare("DELETE FROM literary_prepare_outbox WHERE id=?")
          .bind(id).run().catch(() => {});
        await env.DB.prepare("DELETE FROM rights_grants WHERE id=?")
          .bind(b.grant).run().catch(() => {});
        await env.DB.prepare("DELETE FROM products WHERE id=?")
          .bind(b.product).run().catch(() => {});
        await env.DB.prepare("DELETE FROM gutenberg_source_cache WHERE id=?")
          .bind(b.source).run().catch(() => {});
        await env.DB.prepare("DELETE FROM editions WHERE id=?")
          .bind(b.edition).run().catch(() => {});
      }
    }
  },
};
