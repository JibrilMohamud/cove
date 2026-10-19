import { rightsExactLiteraryFeatureCandidates } from "./discovery-intelligence.server";
import type { CatalogDB } from "./catalog-model.server";

/**
 * Temporary, read-only, protected-stage-only real literary retrieval probe.
 * server.ts invokes this ONLY after its 256-bit secret gate and only when
 * COVE_SSR_STAGING=1. Do not expose it from the ordinary production API.
 * It uses the existing exact-rights candidate implementation and primary DB.
 */
export async function serveStagingLiteraryCandidates(
  request: Request,
  primaryDb: CatalogDB,
): Promise<Response> {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (request.method !== "GET" || keys.length !== 1 || keys[0] !== "term")
    return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
  if (request.headers.has("cookie") || request.headers.has("authorization"))
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  const queries: Record<string, { dimension: string; features: string[] }> = {
    reflective: { dimension: "moods", features: ["reflective"] },
    friendship: { dimension: "themes", features: ["friendship"] },
    mystery: { dimension: "genres", features: ["mystery & thriller"] },
  };
  const chosen = queries[url.searchParams.get("term") || ""];
  const territory = request.headers.get("x-cove-client-country") || "";
  if (!chosen || !/^[A-Z]{2}$/.test(territory))
    return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });

  const started = performance.now();
  const ids = await rightsExactLiteraryFeatureCandidates(
    primaryDb,
    chosen.dimension,
    chosen.features,
    territory,
  );
  // No product ID or work metadata crosses the benchmark interface.
  const encoded = new TextEncoder().encode(JSON.stringify(ids));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const fingerprint = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Response(
    JSON.stringify({
      schema: "cove-stage-literary-rights-read-v1",
      rightsSource: "primary-d1-live",
      count: ids.length,
      fingerprint,
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "server-timing": `cove_literary_read;dur=${(performance.now() - started).toFixed(1)}`,
      },
    },
  );
}
