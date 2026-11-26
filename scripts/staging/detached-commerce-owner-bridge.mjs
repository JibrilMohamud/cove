// This disposable bridge has no D1 or R2 binding. Only two fixed synthetic
// products can be published by the private owner, under a short-lived gate.
export default {
  async fetch(request, env) {
    const headers = {
      "cache-control": "no-store",
      "x-cove-qa-bridge-instance": env.BRIDGE_INSTANCE || "",
    };
    const now = Date.now();
    if (
      !/^[a-f0-9]{32}$/.test(env.BRIDGE_INSTANCE || "") ||
      !/^[a-f0-9]{64}$/.test(env.GATE || "") ||
      !/^[a-f0-9]{64}$/.test(env.OWNER_SECRET || "") ||
      !(Number(env.EXPIRES) > now && Number(env.EXPIRES) <= now + 15 * 60_000)
    )
      return new Response(null, { status: 503, headers });
    if (request.headers.get("authorization") !== "Bearer " + env.GATE)
      return new Response(null, { status: 401, headers });
    const url = new URL(request.url);
    if (url.search) return new Response(null, { status: 404, headers });
    if (url.pathname === "/ready" && request.method === "GET")
      return new Response(null, { status: 204, headers });
    if (url.pathname !== "/publish" || request.method !== "POST" || request.body)
      return new Response(null, { status: 404, headers });
    for (const productId of ["prd_qa_owner_v2_ebook", "prd_qa_owner_v2_audio"]) {
      let epoch;
      for (const path of ["/commercial/publish-verified", "/storefront/publish-commercial"]) {
        const response = await env.LEGAL_PRIVATE.fetch("https://legal-authority.internal" + path, {
          method: "POST",
          headers: {
            authorization: "Bearer " + env.OWNER_SECRET,
            "content-type": "application/json",
          },
          body: JSON.stringify({ productId, territory: "US", currency: "USD", channel: "retail" }),
        });
        if (!response.ok) return new Response(null, { status: 502, headers });
        const proof = await response.json();
        if (
          proof.applied !== true ||
          !Number.isSafeInteger(proof.epoch) ||
          proof.epoch <= 0 ||
          (epoch !== undefined && epoch !== proof.epoch)
        )
          return new Response(null, { status: 502, headers });
        epoch = proof.epoch;
      }
    }
    return new Response(null, { status: 204, headers });
  },
};
