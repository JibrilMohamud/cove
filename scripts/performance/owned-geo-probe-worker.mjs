// A temporary measurement adapter, never a public storefront or generic proxy.
// Its only upstream is the isolated owned HTTPS homepage. Credentials, HTML,
// request headers and client addresses never enter its response or Globalping.
const origin = "https://ssr-canary.covereads.com";
export const ownedGeoColos = ["ORD", "LAX", "IAD", "DFW"];
const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function measureOwnedGeo(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.hostname !== "cove-owned-geo-measurement.cove-jibrilmohamud.workers.dev" ||
    ![1, 4, 8, 16, 32].some((n) => url.pathname === "/" + env.COVE_GEO_CAMPAIGN + "/" + n) ||
    url.search ||
    !/^[a-f0-9]{32}$/.test(env.COVE_GEO_CAMPAIGN || "")
  )
    return reply({ error: "not-found" }, 404);
  const expires = Number(env.COVE_GEO_EXPIRES);
  if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 300000)
    return reply({ error: "expired" }, 410);
  if (
    !/^[a-f0-9]{40}$/.test(env.COVE_GEO_SHA || "") ||
    !/^[a-f0-9]{64}$/.test(env.COVE_SSR_STAGING_GATE_KEY || "") ||
    env.COVE_GEO_ISOLATED_SNAPSHOT !== "15ce2ea3-17f8-4d99-9015-a78a6a3af05d"
  )
    return reply({ error: "configuration" }, 503);
  const colo = request.cf?.colo;
  if (request.cf?.country !== "US" || !ownedGeoColos.includes(colo))
    return reply({ error: "wrong-ingress", colo: colo || null }, 409);
  const concurrency = Number(url.pathname.split("/").at(-1));
  const rows = await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const started = performance.now();
      let status = 0;
      let ttfbMs = null;
      try {
        const result = await fetcher(origin + "/", {
          headers: {
            authorization: "Bearer " + env.COVE_SSR_STAGING_GATE_KEY,
            accept: "text/html",
            "accept-language": "en-US,en;q=0.9",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(12000),
        });
        ttfbMs = performance.now() - started;
        status = result.status;
        const targetColo = /-([A-Z]{3})$/.exec(result.headers.get("cf-ray") || "")?.[1];
        const html = await result.text();
        const cards = (html.match(/class="book-card"/g) || []).length;
        const valid =
          status === 200 &&
          result.headers.get("content-type")?.includes("text/html") &&
          /no-store/.test(result.headers.get("cache-control") || "") &&
          result.headers.get("x-cove-homepage-authority") === "isolated-canonical-primary" &&
          /cove_catalog;dur=[0-9.]+/.test(result.headers.get("server-timing") || "") &&
          targetColo === colo &&
          html.length <= 4000000 &&
          cards > 0;
        return { status, ttfbMs, targetColo: targetColo || null, cards, valid: Boolean(valid) };
      } catch {
        return { status, ttfbMs, targetColo: null, cards: 0, valid: false };
      }
    }),
  );
  return reply({ schema: "cove.owned-geo.v1", sha: env.COVE_GEO_SHA, colo, concurrency, rows });
}

export default { fetch: (request, env) => measureOwnedGeo(request, env) };
