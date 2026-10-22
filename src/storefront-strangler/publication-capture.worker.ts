import { capturePublicSource, type CaptureEnv } from "./publication-capture.server";

// This is a private service-binding capability; no public URL, user identity,
// credentials, R2 or customer route belongs to the capturing worker.
export default {
  async fetch(request: Request, env: CaptureEnv) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run")
      return new Response(null, { status: 404 });
    return Response.json(await capturePublicSource(env));
  },
  scheduled(
    _controller: unknown,
    env: CaptureEnv,
    ctx: { waitUntil(task: Promise<unknown>): void },
  ) {
    ctx.waitUntil(
      capturePublicSource(env).then((value) =>
        console.info(JSON.stringify({ event: "publication_capture", value })),
      ),
    );
  },
};
