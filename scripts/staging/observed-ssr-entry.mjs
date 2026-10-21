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
    headers.set(
      "X-Cove-Stage-Context-Mode",
      env.FORE_ANON_CONTEXT_ONE_READ === "1" ? "one-read" : "baseline",
    );
    headers.set(
      "X-Cove-Stage-Bootstrap-Transport",
      env.FORE_ANON_CONTEXT_ONE_READ === "1" && env.FORE_ANON_BOOTSTRAP_BATCH === "1"
        ? "primary-batch"
        : "individual",
    );
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
