// This disposable bridge has no D1 or R2 binding. Only two fixed synthetic
// products can be published by the private owner, under a short-lived gate.
// An HTTP POST can carry a non-null, zero-length ReadableStream in the
// hosted runtime. Do not infer payload content from stream presence.
// Both readiness and publication use exactly the same route and framing.
async function readOperation(request, instance) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const maximum = 40; // "publish:" plus the exact 32-byte instance
  const bytes = new Uint8Array(maximum);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maximum) return null;
      bytes.set(value, length);
      length += value.byteLength;
    }
    const text = new TextDecoder().decode(bytes.subarray(0, length));
    if (text === "probe:" + instance) return "probe";
    if (text === "publish:" + instance) return "publish";
    if (text === "verify:" + instance) return "verify";
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const products = ["prd_qa_owner_v2_ebook", "prd_qa_owner_v2_audio"];

async function readback(env, headers) {
  const results = [];
  for (const [path, schema] of [
    ["/commercial/authorize-batch", "cove.commercial-legal.v1"],
    ["/storefront/authorize-batch", "cove.storefront-owner.v1"],
  ]) {
    const response = await env.LEGAL_PRIVATE.fetch("https://legal-authority.internal" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.OWNER_SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ids: products, territory: "US", currency: "USD", channel: "retail" }),
    });
    if (!response.ok) {
      headers["x-cove-qa-bridge-phase"] = "readback:" + response.status;
      return new Response(null, { status: 502, headers });
    }
    const data = await response.json();
    if (
      data.schema !== schema ||
      !Array.isArray(data.rows) ||
      data.rows.length > products.length ||
      new Set(data.rows.map((r) => r.product_id)).size !== data.rows.length
    )
      return new Response(null, { status: 502, headers });
    results.push(data.rows);
  }
  const [rights, offers] = results;
  for (const rows of results) {
    if (rows.some((r) => !products.includes(r.product_id)))
      return new Response(null, { status: 502, headers });
  }
  for (const product of products) {
    const key = product.endsWith("ebook") ? "ebook" : "audio";
    const edition = "qa-owner-v2-" + key + "-edition";
    const right = rights.find((r) => r.product_id === product);
    const offer = offers.find((r) => r.product_id === product);
    if (
      (right &&
        (right.edition_id !== edition ||
          right.grant_id !== "qa-owner-v2-" + key + "-us-retail" ||
          right.contract_id !== "qa-owner-v2-contract" ||
          right.contract_version_id !== "qa-owner-v2-contract-v1" ||
          !Number.isSafeInteger(right.epoch) ||
          right.epoch <= 0 ||
          !(Date.parse(right.valid_until) > Date.now()))) ||
      (offer && offer.edition_id !== edition)
    )
      return new Response(null, { status: 502, headers });
    if (offer) {
      let price;
      try {
        price = JSON.parse(offer.offer_json);
      } catch {
        return new Response(null, { status: 502, headers });
      }
      if (!price || typeof price !== "object" || Array.isArray(price))
        return new Response(null, { status: 502, headers });
      if (price.type !== "purchase" || price.currency !== "USD" || price.amountMinor !== 100)
        return new Response(null, { status: 502, headers });
    }
    if (offer && !right) return new Response(null, { status: 502, headers });
  }
  // A marked 409 means an independently read, incomplete publication, not
  // an edge/provider 404. No user data or raw owner response is returned.
  return new Response(null, {
    status: rights.length === products.length && offers.length === products.length ? 204 : 409,
    headers,
  });
}

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
    if (url.pathname !== "/publish" || request.method !== "POST")
      return new Response(null, { status: 404, headers });
    const operation = await readOperation(request, env.BRIDGE_INSTANCE);
    if (!operation) return new Response(null, { status: 400, headers });
    if (operation === "probe") return new Response(null, { status: 204, headers });
    if (operation === "verify") return readback(env, headers);
    for (const productId of products) {
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
        if (!response.ok) {
          // Only fixed stage and status diagnostics; never echo provider bodies.
          headers["x-cove-qa-bridge-phase"] =
            (productId.endsWith("ebook") ? "ebook" : "audio") +
            ":" +
            (path === "/commercial/publish-verified" ? "rights" : "offer") +
            ":" +
            response.status;
          return new Response(null, { status: 502, headers });
        }
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
