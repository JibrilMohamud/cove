/**
 * Protected synthetic-only latency ladder.
 *
 * This route is reachable solely after server.ts' staging bearer check AND
 * only with the isolated diagnostic flag. Never set the flag in production.
 * Every book-bearing stage still uses live primary-D1 territorial rights.
 * Responses expose numeric stage outcomes only; never book IDs or user data.
 */
type DiagnosticEnv = {
  DB: {
    prepare(sql: string): {
      bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> };
      first<T = unknown>(): Promise<T | null>;
    };
  };
  COVE_STOREFRONT_READ_LIMITER?: { limit(options: unknown): Promise<unknown> };
  FORE_DEFAULT_TERRITORY?: string;
  [key: string]: unknown;
};

function diagnosticResponse(stage: string, metrics: Record<string, number | boolean>) {
  return new Response(JSON.stringify({ stage, ...metrics }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-cove-diagnostic": stage,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function serveSyntheticLatencyDiagnostic(request: Request, env: DiagnosticEnv) {
  const stage = new URL(request.url).pathname.slice("/__cove_perf/".length);
  if (request.method !== "GET" || !["edge", "d1", "rights", "bootstrap"].includes(stage))
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

  // Deliberately return no Server-Timing measured inside the Worker: in
  // workerd, JS clocks pause during CPU execution and understate SSR cost.
  if (stage === "edge") return diagnosticResponse(stage, { ok: true });

  if (stage === "d1") {
    const row = await env.DB.prepare("SELECT 1 AS diagnostic_ok").first<{
      diagnostic_ok: number;
    }>();
    if (row?.diagnostic_ok !== 1) throw new Error("Isolated D1 probe failed closed");
    return diagnosticResponse(stage, { ok: true });
  }

  const { networkCountry } = await import("../features/fore/localization.server");
  const country = networkCountry(request, env.FORE_DEFAULT_TERRITORY || "US").country;
  if (stage === "rights") {
    const { firstPaintStorefrontShelf } = await import("../features/fore/search.server");
    const timings: { sqlDurationMs?: number; rowsRead?: number; attempts?: number } = {};
    const shelf = await firstPaintStorefrontShelf(
      env as unknown as Parameters<typeof firstPaintStorefrontShelf>[0],
      null,
      country,
      timings,
    );
    if (!shelf.results.length) throw new Error("Diagnostic rights shelf denied or empty");
    return diagnosticResponse(stage, {
      ok: true,
      books: shelf.results.length,
      ...(timings.sqlDurationMs === undefined ? {} : { sqlMs: timings.sqlDurationMs }),
      ...(timings.rowsRead === undefined ? {} : { rowsRead: timings.rowsRead }),
      ...(timings.attempts === undefined ? {} : { attempts: timings.attempts }),
    });
  }

  const { serveLeanAnonymousBootstrap } =
    await import("../features/fore/storefront-anonymous-bootstrap.server");
  const forwarded = new Request(new URL("/api/fore/storefront/bootstrap", request.url), {
    method: "GET",
    headers: request.headers,
    signal: request.signal,
  });
  const response = await serveLeanAnonymousBootstrap(
    forwarded,
    env as unknown as Parameters<typeof serveLeanAnonymousBootstrap>[1],
  );
  if (!response.ok) throw new Error("Anonymous bootstrap failed closed");
  const body = (await response.json()) as {
    context?: { rightsCountry?: string; availableMarkets?: unknown[] };
    catalog?: { results?: unknown[] };
  };
  if (
    body.context?.rightsCountry !== country ||
    !Array.isArray(body.catalog?.results) ||
    !body.catalog.results.length ||
    !Array.isArray(body.context.availableMarkets)
  )
    throw new Error("Territorial bootstrap invariant failed");
  return diagnosticResponse(stage, {
    ok: true,
    books: body.catalog.results.length,
    markets: body.context.availableMarkets.length,
  });
}
