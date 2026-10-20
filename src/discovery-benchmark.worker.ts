import { syntheticClient } from "./storefront-thin/synthetic-client";
// Protected, synthetic-only architectural diagnostic. Never a production storefront.
import { handleCoveApi, type CoveEnv } from "./features/fore/api.server";
import { publishAnonymousHomeCandidates } from "./features/fore/recommendations.server";
import { publishAnonymousMerchandising } from "./features/fore/merchandising.server";
import { profileD1 } from "./features/fore/d1-cost-profile.server";

export default {
  async fetch(
    request: Request,
    env: CoveEnv & { COVE_BENCHMARK_EPOCH?: string },
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    const key = env.COVE_SSR_STAGING_GATE_KEY;
    if (
      env.COVE_SSR_STAGING !== "1" ||
      env.COVE_PERF_DATABASE_ID !== "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3"
    )
      return new Response(null, { status: 404 });
    const supplied = request.headers.get("authorization")?.slice(7) || "";
    if (!key || !/^[a-f0-9]{64}$/.test(key) || supplied.length !== key.length)
      return new Response(null, { status: 401 });
    // Fixed-length gate comparison. This is a private diagnostic, never application identity.
    let difference = 0;
    for (let i = 0; i < key.length; i++) difference |= key.charCodeAt(i) ^ supplied.charCodeAt(i);
    if (difference) return new Response(null, { status: 401 });
    request = syntheticClient(request, env);
    const url = new URL(request.url);
    if (url.pathname === "/__refresh" && request.method === "POST") {
      const home = await publishAnonymousHomeCandidates(env, "US");
      const merchandising = await publishAnonymousMerchandising(env, {
        territory: "US",
        language: "en",
      });
      return Response.json({ home, merchandising });
    }
    const routes = new Set([
      "/api/fore/storefront/bootstrap",
      "/api/fore/recommendations/home",
      "/api/fore/merchandising",
    ]);
    if (request.method !== "GET" || !routes.has(url.pathname))
      return new Response(null, { status: 404 });
    const mode = url.searchParams.get("mode");
    if (mode !== "control" && mode !== "projection") return new Response(null, { status: 400 });
    url.searchParams.delete("mode");
    const profiled = profileD1(env.DB);
    const bindings = {
      ...env,
      DB: profiled.db,
      FORE_DISCOVERY_READ_MODE: mode === "projection" ? "required" : "legacy",
    };
    const response = await handleCoveApi(new Request(url, request), bindings, ctx);
    if (!response) return new Response(null, { status: 404 });
    const costs = profiled.snapshot();
    const knownSql = costs.samples.filter((sample) => sample.sqlMs !== null);
    response.headers.set("x-cove-d1-statements", String(costs.statements));
    response.headers.set(
      "x-cove-d1-sql-ms",
      String(knownSql.reduce((sum, sample) => sum + sample.sqlMs!, 0)),
    );
    response.headers.set("x-cove-d1-sql-metadata-statements", String(knownSql.length));
    response.headers.set(
      "x-cove-d1-rows-read",
      String(costs.samples.reduce((sum, sample) => sum + (sample.rowsRead || 0), 0)),
    );
    response.headers.set(
      "x-cove-d1-rows-written",
      String(costs.samples.reduce((sum, sample) => sum + (sample.rowsWritten || 0), 0)),
    );
    // Retain attributable statement fingerprints without logging SQL, parameters or identities.
    if (response.status >= 500 || (crypto.getRandomValues(new Uint32Array(1))[0] & 15) === 0)
      console.info(
        JSON.stringify({
          event: "discovery_route_cost",
          route: url.pathname,
          mode,
          requestId: response.headers.get("x-fore-request-id"),
          ...costs,
        }),
      );
    response.headers.set("x-cove-read-model", mode);
    response.headers.set("x-cove-benchmark-epoch", env.COVE_BENCHMARK_EPOCH || "initial");
    return response;
  },
};
