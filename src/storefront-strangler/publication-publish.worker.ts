import { publishPublicPresentation, type PublishEnv } from "./publication-feed.server";
export default {
  async fetch(request: Request, env: PublishEnv) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run")
      return new Response(null, { status: 404 });
    return Response.json(await publishPublicPresentation(env));
  },
  scheduled(
    _controller: unknown,
    env: PublishEnv,
    ctx: { waitUntil(task: Promise<unknown>): void },
  ) {
    ctx.waitUntil(
      publishPublicPresentation(env).then((result) =>
        console.info(JSON.stringify({ event: "presentation_publish", result })),
      ),
    );
  },
};
