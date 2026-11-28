import { capturePublicSource, type CaptureEnv } from "./publication-capture.server";
import {
  canonicalReadonlyD1,
  type CanonicalReadService,
} from "../lib/canonical-readonly-d1.server";

type Env = Omit<CaptureEnv, "SOURCE_DB"> & {
  SOURCE_DB?: unknown;
  COVE_CANONICAL_READONLY?: CanonicalReadService;
};
function scopedCapture(env: Env) {
  if (env.SOURCE_DB || typeof env.COVE_CANONICAL_READONLY?.query !== "function")
    throw Error("capture_provider_readonly_required");
  const source = canonicalReadonlyD1(
    env.COVE_CANONICAL_READONLY,
  ) as unknown as CaptureEnv["SOURCE_DB"];
  return capturePublicSource({ ...env, SOURCE_DB: source });
}

// This is a private service-binding capability; no public URL, user identity,
// credentials, R2 or customer route belongs to the capturing worker.
export default {
  async fetch(request: Request, env: Env) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run")
      return new Response(null, { status: 404 });
    try {
      return Response.json(await scopedCapture(env));
    } catch (error) {
      // Only bounded categories, never upstream SQL or request details.
      const message = error instanceof Error ? error.message : "";
      const reason = /^capture_[a-z_]+$/.test(message)
        ? message
        : /^Canonical read unavailable: HTTP [0-9]{3} code [0-9]+$/.test(message)
          ? message
          : message === "Canonical primary read unavailable"
            ? "canonical_primary_read_unavailable"
            : "capture_unclassified";
      return Response.json({ error: reason }, { status: 503 });
    }
  },
  scheduled(_controller: unknown, env: Env, ctx: { waitUntil(task: Promise<unknown>): void }) {
    ctx.waitUntil(
      scopedCapture(env).then((value) =>
        console.info(JSON.stringify({ event: "publication_capture", value })),
      ),
    );
  },
};
