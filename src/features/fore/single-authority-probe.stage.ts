import { canonicalBoundedPopularPageByLiveRights } from "./catalog-model.server";

// An isolated capacity reference, NOT a storefront response. It intentionally
// bypasses localization and presentation for a single genuine primary-D1
// full-shape current-rights query; it does not authorize real delivery.
const PRIVATE_STAGE_HOST = "cove-presentation-r2-proof-20261114.cove-jibrilmohamud.workers.dev";
const SYNTHETIC_DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const PROBE_PATH = "/api/fore/__perf/private-authority";

export type PrivateAuthorityStageEnv = {
  DB?: Parameters<typeof canonicalBoundedPopularPageByLiveRights>[0];
  FORE_GUEST_COMPACT_STAGE?: string;
  FORE_GUEST_COMPACT_SYNTHETIC_D1_ID?: string;
  FORE_BACKEND_TOKEN?: string;
  COVE_PUBLIC_PRESENTATION_CACHE?: object;
};

function constantTimeToken(supplied: string | null, expected: string | undefined) {
  if (
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    !supplied ||
    supplied.length !== expected.length
  )
    return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++)
    mismatch |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

export function isPrivateAuthorityStageProbeAuthorized(
  request: Request,
  env: PrivateAuthorityStageEnv,
) {
  const url = new URL(request.url);
  return (
    url.hostname === PRIVATE_STAGE_HOST &&
    url.pathname === PROBE_PATH &&
    request.method === "GET" &&
    env.FORE_GUEST_COMPACT_STAGE === "1" &&
    env.FORE_GUEST_COMPACT_SYNTHETIC_D1_ID === SYNTHETIC_DB &&
    !!env.COVE_PUBLIC_PRESENTATION_CACHE &&
    !!env.DB &&
    !request.headers.has("cookie") &&
    !request.headers.has("authorization") &&
    !request.headers.has("x-fore-authenticated-user-id") &&
    !request.headers.has("oai-authenticated-user-id") &&
    request.headers.get("x-cove-client-country") === "US" &&
    constantTimeToken(request.headers.get("x-cove-backend-token"), env.FORE_BACKEND_TOKEN)
  );
}

export async function handlePrivateAuthorityStageProbe(
  request: Request,
  env: PrivateAuthorityStageEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PROBE_PATH) return null;
  if (!isPrivateAuthorityStageProbeAuthorized(request, env))
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const scope = {
    where: [
      "p.storefront_status='active'",
      "p.source_name<>'upload'",
      "d.suppressed=0",
      "e.release_status IN ('available','preorder')",
      "d.availability=?",
      "EXISTS(SELECT 1 FROM retail_product_availability_rows rpa WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))",
      "d.currency=?",
    ],
    binds: ["available", "US", "USD"],
  };
  try {
    const books = await canonicalBoundedPopularPageByLiveRights(env.DB!, scope, 24);
    if (!books || books.length !== 24 || !books.every((book) => book.productId))
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    return Response.json(
      { results: books, releaseCertified: false, mode: "single-primary-rights-only" },
      {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "x-cove-persistence": "d1-only-synthetic",
        },
      },
    );
  } catch {
    // Only classified status is exposed; no SQL, source IDs, errors or secrets.
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
