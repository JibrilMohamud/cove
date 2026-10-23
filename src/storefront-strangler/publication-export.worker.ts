import { exportPublicPresentation, type ExportEnv } from "./publication-feed.server";
export default {
  // This deployment has no public ingress. Its service-binding capability
  // has one fixed operation and accepts no source SQL or publication data.
  async fetch(request: Request, env: ExportEnv) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run")
      return new Response(null, { status: 404 });
    return Response.json(await exportPublicPresentation(env));
  },
  scheduled(
    _controller: unknown,
    env: ExportEnv,
    ctx: { waitUntil(task: Promise<unknown>): void },
  ) {
    ctx.waitUntil(
      exportPublicPresentation(env).then((result) =>
        console.info(JSON.stringify({ event: "presentation_export", ...result })),
      ),
    );
  },
};
