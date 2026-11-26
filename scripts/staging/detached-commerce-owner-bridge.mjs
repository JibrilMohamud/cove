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
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
