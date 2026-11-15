import backend from "./persistence-backend.worker";

export { BackendOwnerAttestation } from "./storefront-strangler/backend-owner-attestation-entrypoint";

// Private synthetic capacity experiment only. This entry intercepts the
// explicitly named probe BEFORE normal API logicalRequest strips the backend
// token and before legacy per-request D1 audit writes. The full production
// backend and every normal customer route remain on their unchanged path.
const PRIVATE_PROBE = "/api/fore/__perf/private-r2-live-rights";

export default {
  ...backend,
  async fetch(
    request: Request,
    env: Parameters<typeof backend.fetch>[1],
    ctx: Parameters<typeof backend.fetch>[2],
  ) {
    const path = new URL(request.url).pathname;
    if (path === PRIVATE_PROBE || path === PRIVATE_PROBE + "/seed") {
      const { handleSyntheticR2LiveRightsStage } = await import(
        "./features/fore/synthetic-r2-live-rights-page.stage"
      );
      const stage = await handleSyntheticR2LiveRightsStage(request, env);
      if (stage) return stage;
    }
    return backend.fetch(request, env, ctx);
  },
};
