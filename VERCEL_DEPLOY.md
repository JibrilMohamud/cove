# Cove on Vercel

Cove uses Vercel Services for the public application and bounded audio compute, while a dedicated private persistence backend owns the existing D1 database and R2 object bucket.

## Production topology

```text
Browser
  |
  v
Vercel app (TanStack Start)
  |
  | x-cove-backend-token
  v
Cove persistence backend (Worker)
  |-- D1: catalog, accounts, commerce, rights, jobs, sync, operational state
  |-- R2: EPUBs, audio, BioSync text/timing, publisher assets
  |
  +-- Cloudflare edge cache for anonymous catalog metadata

Vercel app ----service binding----> audio_pipeline (FastAPI)
                                      |
                                      | FORE_BACKEND_TOKEN + scoped FORE_SERVICE_TOKEN
                                      v
                                persistence backend
```

The persistence backend is intentionally the system of record. Vercel never pretends to provide D1/R2 bindings and no commercial/account write falls back to an ephemeral implementation.

## Vercel Services

- `app`: repository root, TanStack Start, the only public service.
- `audio_pipeline`: `scripts/`, FastAPI, internal only.
- `app -> audio_pipeline`: `COVE_AUDIO_PIPELINE_URL`.
- `audio_pipeline -> persistence backend`: direct HTTPS using `FORE_BACKEND_URL`, `FORE_BACKEND_TOKEN`, and its scoped `FORE_SERVICE_TOKEN`.

The Vercel binding is used only by authenticated ingestion controllers and should not be configured manually. The audio service deliberately calls the persistence backend directly, avoiding a circular service dependency.

## Required Vercel server variables

```text
FORE_PUBLIC_URL=https://<your-production-domain>
FORE_BACKEND_URL=https://<your-persistence-worker>
FORE_BACKEND_TOKEN=<32+ random bytes>
FORE_INGESTION_TRIGGER_TOKEN=<32+ random bytes>
```

The internal audio service additionally requires its scoped `FORE_SERVICE_TOKEN`. Do not put any of these values in `VITE_*` variables.

## D1/R2 persistence backend

Build the Worker bundle with:

```sh
npm run build:backend
```

Use `wrangler.backend.example.toml` as the deployment template. Point its `DB` and `BUCKET` bindings at Cove's existing production resources when preserving the current data, or create fresh resources for an isolated migration.

The backend must receive the same `FORE_BACKEND_TOKEN` as Vercel. It reconstructs incoming requests at `FORE_PUBLIC_URL`, so Cove's same-origin CSRF checks, Supabase redirects, cookies, and absolute URLs continue to use the public Vercel origin rather than the private Worker origin.

See `docs/VERCEL_PERSISTENCE_BACKEND.md` for provisioning and cutover.

## Cache hierarchy

Cove deliberately uses several cache layers with different jobs:

1. D1 remains authoritative for mutable application state and contains Cove's durable API/source cache.
2. R2 stores immutable or content-addressed media and publication assets.
3. The persistence Worker uses `caches.default` for anonymous public metadata. Keys include country and primary language. Authenticated, cookie-bearing, range, and mutation requests bypass it.
4. Browser-facing API responses from the backend are returned `no-store`, preventing a shared CDN/browser cache from accidentally crossing entitlement or territory boundaries.
5. If the persistence backend is temporarily unavailable, only an explicit allowlist of public-domain GETs may fall back to the stateless Gutenberg adapter. Writes and account/commercial reads fail closed.

Typical Worker edge TTLs are 60-900 seconds; durable source/object caches are much longer.

## eBook ingestion

The persistence Worker's catalog cron runs every five minutes and advances the existing restartable D1 ingestion cursor directly in bounded batches. Separate Worker cron triggers call Vercel's token-gated controller only for Python audio compute.

The underlying harvester retains the existing guarantees:

- accepts Project Gutenberg US records only when `copyright === false`;
- checkpoints pagination in D1;
- exponential retry/backoff;
- federated Canada/Australia/Europe rights pipelines remain independently scoped;
- materializes Work -> Edition -> Product projections;
- updates taxonomy and search projections;
- verifies/caches canonical EPUBs into R2;
- keeps customer request paths separate from ingestion.

Catalog page requests can still opportunistically kick one bounded ingestion unit with `waitUntil`, but the backend Worker cron triggers are the primary scheduler.

## Audiobook ingestion

Audio is deliberately staged:

1. **scan**: refresh the official Gutenberg bulk catalog/daily feed and queue discovery records;
2. **discover**: validate RDF rights/metadata, preserve every track, classify narration only from evidence, and queue track jobs;
3. **track**: resumably download, checksum, inspect duration, upload content-addressed media to R2, and make playback available;
4. **align**: independently fetch the prepared bytes, pin the matching EPUB, run ASR/BioSync alignment, verify exact checksums/cues, then publish timing objects;
5. **retry/review**: D1 leases, attempts, exponential retry, and review states make every stage restartable.

Playback therefore does not depend on BioSync succeeding. A transcription timeout cannot hide an otherwise valid audiobook.

The Python service receives the universal 300-second Fluid Compute window. Heavier alignment can later move to Vercel Workflow or dedicated worker compute without changing the D1 job contract.

## Health and failure behavior

- `GET /__cove/health` on the private backend validates D1 and reports R2 binding presence; it requires the gateway token.
- `GET /api/fore/health/ready` through Vercel reaches the persistent backend once configured.
- Safe public-domain reads degrade to the bundled/live stateless Gutenberg adapter during persistence-backend 502/503/504 failures.
- Mutations, authentication state, entitlements, commerce, publishing and private media fail closed instead of silently becoming stateless.

## Verification

Run:

```sh
npm run typecheck
npm run test:persistence-backend
npm run build
npm run build:backend
python3 -m py_compile scripts/audio_pipeline/*.py
```

Production is not considered fully cut over until the backend Worker is deployed against the intended D1/R2 resources and the Vercel variables above are configured.
