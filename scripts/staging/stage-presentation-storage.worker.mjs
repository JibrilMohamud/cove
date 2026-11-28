// Ephemeral CI-only stage storage; no D1, service binding, route or cron.
export default {
  async fetch(request, env) {
    const headers = { "cache-control": "no-store" };
    const reply = (status) => new Response(null, { status, headers });
    const supplied = request.headers.get("authorization") || "";
    if (!/^[a-f0-9]{64}$/.test(env.GATE || "") || !/^Bearer [a-f0-9]{64}$/.test(supplied))
      return reply(401);
    const digest = async (value) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    const [a, b] = await Promise.all([digest(supplied), digest("Bearer " + env.GATE)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    if (diff) return reply(401);
    if (Date.now() >= Number(env.EXPIRES) || !Number.isSafeInteger(Number(env.EXPIRES)))
      return reply(403);
    if (!/^[1-9][0-9]{7,14}$/.test(env.RUN) || !["synthetic", "real"].includes(env.MODE))
      return reply(403);
    if (!/^[a-f0-9]{32}$/.test(env.INSTANCE || "") || !["publish", "cleanup"].includes(env.PURPOSE))
      return reply(403);
    headers["x-cove-stage-storage-instance"] = env.INSTANCE;
    const url = new URL(request.url);
    if (url.search || url.pathname !== "/presentation") return reply(404);
    const country = request.headers.get("x-cove-country") || "";
    if (!/^[A-Z]{2}$/.test(country)) return reply(400);
    const key = `campaign/${env.RUN}/${env.MODE}/private/presentation/v2/home/${country}.json`;
    if (request.method === "DELETE") {
      if (env.PURPOSE !== "cleanup") return reply(403);
      await env.PRESENTATION.delete(key);
      await env.PRESENTATION_KV.delete(key);
      return reply(204);
    }
    if (request.method === "GET") {
      const object = await env.PRESENTATION.get(key);
      return object ? new Response(object.body, { headers }) : reply(404);
    }
    if (request.method !== "PUT") return reply(405);
    if (env.PURPOSE !== "publish") return reply(403);
    const length = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 1 || length > 524288) return reply(413);
    const reader = request.body?.getReader();
    if (!reader) return reply(400);
    const body = new Uint8Array(length);
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > length) {
        await reader.cancel();
        return reply(413);
      }
      body.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== length) return reply(400);
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return reply(400);
    }
    if (
      data?.schema !== "cove.home.presentation.v2" ||
      data.candidates?.country !== country ||
      !Array.isArray(data.displayBooks) ||
      data.displayBooks.some(
        (book) =>
          !book ||
          typeof book !== "object" ||
          "offer" in book ||
          "subscriptionEligible" in book ||
          "libraryEligible" in book,
      )
    )
      return reply(400);
    await env.PRESENTATION.put(key, body, { httpMetadata: { contentType: "application/json" } });
    await env.PRESENTATION_KV.put(key, body, { expirationTtl: 1800 });
    return reply(204);
  },
};
