import { createFileRoute } from "@tanstack/react-router";
import { runEpubWorker, runIngest } from "@/lib/ingest";

async function handle(request: Request) {
  const configuredSecret = process.env.INGEST_SECRET;
  if (configuredSecret) {
    const supplied =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      new URL(request.url).searchParams.get("secret");
    if (supplied !== configuredSecret) return new Response("Unauthorized", { status: 401 });
  }

  try {
    const requestedLimit = Number(new URL(request.url).searchParams.get("epubs") ?? 3);
    const [catalog, epubs] = await Promise.all([runIngest(), runEpubWorker(requestedLimit)]);
    return Response.json({ ok: true, catalog, epubs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

// Schedule this endpoint every few minutes. Every invocation follows Gutendex's
// `next` URL and also drains a bounded number of EPUB download jobs.
export const Route = createFileRoute("/api/public/hooks/ingest")({
  server: {
    handlers: { GET: ({ request }) => handle(request), POST: ({ request }) => handle(request) },
  },
});
