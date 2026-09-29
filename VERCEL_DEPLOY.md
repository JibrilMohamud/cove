# Cove on Vercel

Cove's Vercel Services draft lives in `vercel.json`.

## Proposed service topology

- `app` — the TanStack Start/Lovable application at the repository root. Vercel is allowed to auto-detect the framework rather than pinning an inferred framework identifier.
- `audio_pipeline` — a FastAPI wrapper around `scripts/audio_pipeline`, using `service:app` as its entrypoint.

Only `app` is publicly routed. `audio_pipeline` is internal by default.

The existing audio worker calls the Cove application, so the binding is declared on the calling service:

```text
audio_pipeline -> app
COVE_APP_INTERNAL_URL
```

Vercel injects `COVE_APP_INTERNAL_URL`; do not add it manually to project environment variables. Outside Vercel Services, the CLI worker still supports `FORE_SITE_URL` as a fallback.

The internal FastAPI wrapper exposes `/health` and a bounded `/run` endpoint. No public rewrite currently points to those routes.

## Important runtime boundary: database and object storage

Cove's commercial API still uses Cloudflare-style `DB` (D1) and `BUCKET` (R2) bindings. Vercel does not provide those bindings automatically. The app can be built and served on Vercel, and `/api/fore/health/live` remains usable, but database-backed catalog, account, commerce, publishing, sync, and object-storage flows require either:

1. a compatibility adapter to a Vercel-accessible database/object store, or
2. proxying `/api/fore/*` to the existing Cloudflare Worker that owns D1/R2.

Do not set Cloudflare credentials in client-visible `VITE_*` variables. Server secrets belong in Vercel environment variables only.

## Important runtime boundary: audio processing

The current audio pipeline performs large media downloads, transcription/alignment, and local caching. The FastAPI wrapper deliberately defaults to one bounded job and skips bulk discovery. Before production use, confirm the Vercel plan/function duration and dependency-size limits, and decide whether this workload should stay request-bound, move to Vercel Workflow/Queues, or remain on dedicated worker compute.

The service topology is intentionally a review draft until the service names, public routes, and bindings are confirmed.
