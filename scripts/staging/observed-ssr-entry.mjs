import app from "../../.output/server/index.mjs";

// Stage-only entry point around the generated Nitro Worker. Measure before
// framework dispatch, without buffering or changing the application response.
export default {
  ...app,
  async fetch(request, env, ctx) {
    const started = performance.now();
    const response = await app.fetch(request, env, ctx);
    if (env.COVE_SSR_STAGING !== "1" || response.status !== 200) return response;
    const headers = new Headers(response.headers);
    headers.append(
      "Server-Timing",
      `cove_worker_dispatch;dur=${(performance.now() - started).toFixed(1)}`,
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
