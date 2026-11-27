// Ephemeral detached commerce QA only. The application retains its existing
// bearer, account, HMAC and legal-owner checks. This marker identifies which
// deployed wrapper answered; it never authorizes a request or contains a key.
const hostname = "cove-commerce-customer-qa-stage.cove-qa-reads.workers.dev";
export function commerceQaIngress(app, instance) {
  if (!/^[a-f0-9]{32}$/.test(instance || "")) throw Error("Invalid QA ingress instance");
  return {
    async fetch(request, env, ctx) {
      if (
        new URL(request.url).hostname !== hostname ||
        env.COVE_SSR_STAGING !== "1" ||
        env.COVE_SSR_STAGING_COMMERCE_QA !== "1" ||
        env.STRIPE_LIVEMODE !== "false" ||
        env.COVE_LEGAL_WRITER_PRIMARY_ID !== "f9354381-bd9f-496b-bd05-d6f62a32ec0c"
      )
        return new Response(null, { status: 503 });
      const response = await app.fetch(request, env, ctx);
      const headers = new Headers(response.headers);
      headers.set("x-cove-qa-ingress-instance", instance);
      headers.set("cache-control", "no-store, max-age=0");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}
