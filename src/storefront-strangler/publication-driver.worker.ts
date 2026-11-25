import { timingSafeEqual } from "node:crypto";
import { readHomepagePresentation } from "./homepage-presentation.server";
import type { PrivatePresentationStore } from "./prepared-catalog.server";
import type { StorefrontDB } from "./localization-optimized.server";

// Ephemeral CI operator only. It has no source/primary database binding.
type Env = {
  GATE: string;
  PREFIX: string;
  CAPTURE?: { fetch(r: Request): Promise<Response> };
  EXPORTER: { fetch(r: Request): Promise<Response> };
  PUBLISHER: { fetch(r: Request): Promise<Response> };
  PRESENTATION: PrivatePresentationStore;
  DISCOVERY_DB?: StorefrontDB;
  COVE_QA_EXPIRES?: string;
};
export default {
  async fetch(request: Request, env: Env) {
    if (!/^[a-f0-9]{64}$/.test(env.GATE || "")) return new Response(null, { status: 503 });
    const actual = new TextEncoder().encode(request.headers.get("authorization") || "");
    const expected = new TextEncoder().encode("Bearer " + env.GATE);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return new Response(null, { status: 401 });
    if (
      env.COVE_QA_EXPIRES !== undefined &&
      (!Number.isSafeInteger(Number(env.COVE_QA_EXPIRES)) ||
        Date.now() >= Number(env.COVE_QA_EXPIRES))
    )
      return new Response(null, { status: 403 });
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && (path === "/reset-ledger" || path === "/refresh-ledger")) {
      if (!env.DISCOVERY_DB || !/^feed\/campaign\/[1-9][0-9]{7,14}\/$/.test(env.PREFIX))
        return new Response(null, { status: 403 });
      const db = env.DISCOVERY_DB;
      const identity = await db
        .prepare("SELECT domain FROM discovery_domain_identity WHERE id=1")
        .first<{ domain: string }>();
      if (identity?.domain !== "cove-public-presentation")
        return new Response(null, { status: 403 });
      // Never steal a live lease; only fixed QA ledger operations are exposed.
      const busy = await db
        .prepare("SELECT COUNT(*) n FROM discovery_publications WHERE lease_until>?")
        .bind(Date.now())
        .first<{ n: number }>();
      if (busy?.n !== 0) return new Response(null, { status: 409 });
      if (path === "/reset-ledger")
        await db
          .prepare(
            "UPDATE discovery_publications SET status='delivered',attempts=0,due_at=0,lease_token='',lease_until=0 WHERE lease_until<=?",
          )
          .bind(Date.now())
          .run();
      else
        await db
          .prepare(
            "UPDATE discovery_publications SET due_at=0 WHERE status='delivered' AND lease_until<=?",
          )
          .bind(Date.now())
          .run();
      return Response.json({ ok: true });
    }
    if (
      request.method === "POST" &&
      (path === "/capture" || path === "/export" || path === "/publish")
    ) {
      const service =
        path === "/capture" ? env.CAPTURE : path === "/export" ? env.EXPORTER : env.PUBLISHER;
      if (!service) return new Response(null, { status: 503 });
      return service.fetch(new Request("https://private/run", { method: "POST" }));
    }
    if (request.method === "GET" && path === "/verify") {
      const result = [];
      for (const country of ["US", "CA", "SA", "JP"]) {
        const p = await readHomepagePresentation(
          { get: (key) => env.PRESENTATION.get(env.PREFIX + key) },
          new Request("https://private/"),
          country,
        );
        result.push({
          country: p.candidates.country,
          candidates: p.candidates.productIds.length,
          expires: p.candidates.expiresAt,
          display: p.displayBooks.length,
        });
      }
      return Response.json(result);
    }
    return new Response(null, { status: 404 });
  },
};
