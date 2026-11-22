// This helper has ONE synthetic D1 binding and ONE private QA bucket.
// It receives no Cloudflare credential and cannot select a database or bucket.
const database = "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const bucket = "cove-paid-credential-isolation-qa";
const keys = new Set(["qa/book.epub", "qa/chapter.wav", "qa/rights.txt"]);
const headers = { "cache-control": "no-store" };
export default {
  async fetch(request, env) {
    const expires = Number(env.QA_EXPIRES_AT);
    if (
      env.QA_DATABASE_ID !== database ||
      env.QA_BUCKET_NAME !== bucket ||
      !/^[a-f0-9]{64}$/.test(env.QA_GATE || "") ||
      !Number.isSafeInteger(expires) ||
      expires <= Date.now() ||
      expires > Date.now() + 30 * 60_000
    )
      return new Response(null, { status: 503, headers });
    if (request.headers.get("authorization") !== "Bearer " + env.QA_GATE)
      return new Response(null, { status: 401, headers });
    const route = new URL(request.url).pathname;
    if (request.method === "GET" && route === "/ready")
      return Response.json({ ready: true, database, bucket, authorizing: false }, { headers });
    if (request.method !== "POST" || !["/query", "/media/put", "/media/delete"].includes(route))
      return new Response(null, { status: 404, headers });
    try {
      const text = await request.text();
      if (text.length > 140_000) return new Response(null, { status: 413, headers });
      const body = JSON.parse(text);
      if (route === "/query") {
        if (
          Object.keys(body).some((key) => !["sql", "params"].includes(key)) ||
          typeof body.sql !== "string" ||
          !body.sql.trim() ||
          body.sql.length > 50_000 ||
          !Array.isArray(body.params) ||
          body.params.length > 100 ||
          !body.params.every(
            (value) =>
              value === null ||
              typeof value === "string" ||
              (typeof value === "number" && Number.isFinite(value)),
          )
        )
          return new Response(null, { status: 400, headers });
        const result = await env.QA_DB.prepare(body.sql)
          .bind(...body.params)
          .all();
        return Response.json(result, { headers });
      }
      if (!keys.has(body.key) || Object.keys(body).some((key) => !["key", "base64"].includes(key)))
        return new Response(null, { status: 400, headers });
      if (route === "/media/put") {
        if (typeof body.base64 !== "string" || body.base64.length > 130_000)
          return new Response(null, { status: 400, headers });
        const bytes = Uint8Array.from(atob(body.base64), (ch) => ch.charCodeAt(0));
        await env.QA_MEDIA.put(body.key, bytes);
      } else await env.QA_MEDIA.delete(body.key);
      return Response.json({ success: true }, { headers });
    } catch {
      // Never return SQL, row contents, credentials, or provider exception strings.
      return new Response(null, { status: 503, headers });
    }
  },
};
