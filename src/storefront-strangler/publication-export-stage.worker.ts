// Non-routable, CI-only correctness harness. It deliberately reads the
// canonical source to prove staging publication fidelity; never deploy this
// entrypoint with a schedule, public route, or release certification.
import { exportPublicPresentation, type ExportEnv } from "./publication-feed.server";
export default {
  async fetch(request: Request, env: ExportEnv) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run")
      return new Response(null, { status: 404 });
    return Response.json(
      await exportPublicPresentation(env, { allowCanonicalStageFixture: true }),
    );
  },
};
