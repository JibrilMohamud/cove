/** Synthetic benchmark ingress only. Both renderers share one hostname/pool.
 * No database, cache, rights decisions or credentials live here. Each target
 * performs its own existing staging bearer check before touching any data.
 */
export default {
  async fetch(
    request: Request,
    env: {
      BASELINE: { fetch(request: Request): Promise<Response> };
      THIN: { fetch(request: Request): Promise<Response> };
    },
  ): Promise<Response> {
    const role = request.headers.get("x-cove-perf-renderer");
    if (!["baseline", "thin"].includes(role || "") || !["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    const headers = new Headers(request.headers);
    headers.delete("x-cove-perf-renderer");
    const target = role === "baseline" ? env.BASELINE : env.THIN;
    return target.fetch(new Request(request, { headers }));
  },
};
