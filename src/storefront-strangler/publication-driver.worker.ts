import { timingSafeEqual } from "node:crypto";
import { readHomepagePresentation } from "./homepage-presentation.server";
import type { PrivatePresentationStore } from "./prepared-catalog.server";

// Ephemeral CI operator only. It has no source/primary database binding.
type Env = {
  GATE: string;
  PREFIX: string;
  CAPTURE?: { fetch(r: Request): Promise<Response> };
  EXPORTER: { fetch(r: Request): Promise<Response> };
  PUBLISHER: { fetch(r: Request): Promise<Response> };
  PRESENTATION: PrivatePresentationStore;
};
export default {
  async fetch(request: Request, env: Env) {
    if (!/^[a-f0-9]{64}$/.test(env.GATE || "")) return new Response(null, { status: 503 });
    const actual = new TextEncoder().encode(request.headers.get("authorization") || "");
    const expected = new TextEncoder().encode("Bearer " + env.GATE);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
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
