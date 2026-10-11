# Vercel persistence backend and ingestion runbook

## Why Cove keeps D1/R2

Cove already has a large SQLite/D1 schema covering normalized catalog identity, storefronts, accounts, rights, commerce, finance, publishing, moderation, recommendations, search fallback, synchronization, operational queues, audiobook jobs and BioSync. It also has R2 object-key contracts for EPUBs, publisher assets, audio media and content-addressed timing data.

The safest Vercel migration is therefore an **application migration, not a data-engine rewrite**:

- Vercel owns public web/SSR and bounded Python audio compute.
- The dedicated Cove persistence Worker owns D1/R2, runs the existing domain API, and owns the durable ingestion schedule.
- The public origin is still Vercel.
- D1/R2 remain authoritative until Cove intentionally performs a separate data-store migration.

This avoids translating FTS5, SQLite JSON expressions, RETURNING/UPSERT behavior and more than forty ordered migrations into another SQL dialect during the hosting move.

## 1. Prepare the persistence Worker

### Preferred: GitHub production workflow

Run the repository's manual `deploy-persistence-backend` GitHub Actions workflow. Provide:

- the existing Worker name when you want to preserve that Worker's existing provider secrets;
- the existing D1 database name and UUID;
- the existing R2 bucket name;
- the canonical HTTPS Vercel origin;
- whether pending D1 migrations should be applied.

Cove's production Cloudflare resource identifiers are already recorded in the repository:

```text
Account ID: d26430caa63ec55f6612e32f36aca5e9
Worker: cove-persistence-backend
workers.dev origin: https://cove-persistence-backend.cove-jibrilmohamud.workers.dev
D1 database: cove-production
D1 UUID: 4bd657ac-8789-403e-a28c-93aba8d0a989
R2 bucket: cove-production-media
```

Configure these GitHub Actions secrets before using the production deployment workflow:

```text
CLOUDFLARE_API_TOKEN
FORE_BACKEND_TOKEN
FORE_INGESTION_TRIGGER_TOKEN
```

The Cloudflare account ID is non-secret and is already pinned in the deployment workflow.

The workflow validates resource identifiers, builds `backend-dist/worker.js`, applies pending migrations with `wrangler d1 migrations apply DB --remote`, deploys through `cloudflare/wrangler-action@v4`, and passes the two Cove gateway secrets without writing them to the repository.

If you deploy under a brand-new Worker name instead of the existing owner Worker, separately copy all enabled server-side provider secrets (Supabase, Stripe, search, notifications, tax, publishing/operations, observability, etc.) into the new Worker before cutover.

### R2 account activation

R2 is active for Cove production, and the private `cove-production-media` bucket is bound to the live persistence Worker. The original setup encountered API error `10042: Please enable R2 through the Cloudflare Dashboard`. On a new account that returns this error:

1. Open the Cloudflare dashboard.
2. Select **R2 Object Storage**.
3. Complete **Get started / Enable R2** and any billing acknowledgement Cloudflare presents.
4. After activation, create (or let the Cove setup create) the bucket `cove-production-media`.

Do not enable public `r2.dev` access for the bucket. Cove accesses objects through the private Worker binding and serves authorized bytes through its API.

### Local/operator path

Build:

```sh
npm ci
npm run build:backend
cp wrangler.backend.example.toml wrangler.backend.toml
```

Edit the local, uncommitted `wrangler.backend.toml`:

- point `database_id` at the existing Cove production D1 database;
- set `bucket_name` to the existing Cove R2 bucket;
- set `FORE_PUBLIC_URL` to the final Vercel production origin.

If creating isolated resources instead of reusing production, create D1/R2 first and then use those new identifiers.

Apply only pending migrations, in the existing journal order:

```sh
npx wrangler d1 migrations apply cove-production --remote --config wrangler.backend.toml
```

D1 tracks applied migrations. Do not concatenate/reorder the SQL files.

## 2. Provision the gateway secret

Generate one high-entropy value. Store the exact same value as `FORE_BACKEND_TOKEN` in:

- the persistence Worker secret store;
- Vercel Production/Preview server environment.

Never commit it and never use a `VITE_*` name.

Example Worker command:

```sh
npx wrangler secret put FORE_BACKEND_TOKEN --config wrangler.backend.toml
```

Configure the backend's existing server secrets as needed: Supabase, Stripe, publishing, search, notifications, tax, observability and other enabled provider credentials. The Worker, not the browser, owns those credentials.

## 3. Deploy the backend

If you are not using the GitHub workflow:

```sh
npm run build:backend
npx wrangler deploy --config wrangler.backend.toml
```

Record the resulting HTTPS Worker URL as Vercel's server-only `FORE_BACKEND_URL`.

The Worker is still reachable on the network, but every route—including health—is gateway-token protected. For additional defense, restrict its hostname with Cloudflare access/firewall policy after confirming Vercel egress requirements.

## 4. Configure Vercel

Set:

```text
FORE_PUBLIC_URL
FORE_BACKEND_URL
FORE_BACKEND_TOKEN
FORE_INGESTION_TRIGGER_TOKEN
```

Keep `FORE_SERVICE_TOKEN` scoped to the audio pipeline service. It must be a Cove service-principal credential with the scopes used by the pipeline (catalog ingestion and audio preparation), not a human/staff bearer token.

Do not manually set `COVE_AUDIO_PIPELINE_URL`; Vercel injects that service binding. The audio service uses `FORE_BACKEND_URL` directly and authenticates with both the gateway token and its scoped Cove service credential.

Redeploy after environment changes.

## 5. Verify before enabling broad traffic

Check the backend directly with the gateway token from a trusted shell:

```sh
curl -fsS "$FORE_BACKEND_URL/__cove/health" \
  -H "x-cove-backend-token: $FORE_BACKEND_TOKEN"
```

Then verify through the public Vercel origin:

```sh
curl -i "$FORE_PUBLIC_URL/api/fore/health/ready"
curl -i "$FORE_PUBLIC_URL/api/fore/catalog"
curl -i "$FORE_PUBLIC_URL/api/fore/audiobooks"
```

Persistent responses include:

```text
x-cove-persistence: remote-d1-r2
```

The backend also reports `x-cove-backend-cache: HIT|MISS` for cacheable reads.

Test at least:

- anonymous catalog browse/search;
- one EPUB read/download;
- Supabase login callback and cookie persistence;
- library/sync write and reload;
- one test-mode checkout if Stripe is enabled;
- audiobook listing, track playback and byte seeking;
- staff/publisher paths relevant to your deployment.

## 6. Cache design

### Authoritative state

D1 is authoritative for all mutable application/domain state. R2 is authoritative for stored media/object bytes referenced by D1.

### Worker edge metadata cache

The backend caches only anonymous GET metadata. Cache identity includes:

- full path/query;
- storefront country;
- primary accepted language.

Requests bypass cache when they carry:

- `Authorization`;
- cookies;
- authenticated-user identity headers;
- Range;
- any non-GET method.

This is intentional. Entitlements, carts, recommendations tied to an account, playback positions and private records are never shared.

Current short TTLs:

| Surface | TTL |
| --- | ---: |
| Search suggestions | 60 s |
| Catalog | 90 s |
| Storefront page | 300 s |
| Audiobook browse | 300 s |
| Book detail | 300 s |
| Audio edition metadata | 900 s |
| Taxonomy | 900 s |

R2 objects use their existing content-addressing/checksum semantics and can have much longer immutable cache lifetimes.

## 7. eBook ingestion

The persistence Worker advances eBook ingestion directly every five minutes. Its other cron triggers call Vercel's protected audio-ingestion controller with `FORE_INGESTION_TRIGGER_TOKEN` when Python media compute is required.

The Worker processes up to five catalog pages or roughly 220 seconds, whichever comes first. The `/__cove/ingestion/catalog` control route remains available for authenticated manual/recovery runs.

Each normal ingestion unit:

1. verifies source response shape/origin;
2. accepts only eligible rights state;
3. writes source cache records;
4. materializes commercial catalog projections;
5. synchronizes taxonomy;
6. advances search outbox/index state;
7. persists cursor/success/backoff;
8. verifies a bounded number of pending EPUBs into R2.

Because cursor, attempts and next-run state live in D1, a timed-out invocation resumes instead of starting over.

## 8. Audiobook ingestion

### Daily scan

`audio-scan` refreshes Gutenberg's official bulk CSV no more than once per ~20 hours and includes the daily RSS feed. It only queues discovery jobs; it does not transcribe audio in the scan invocation.

### Discovery drain

`audio-discover` validates individual RDF records and exact U.S. public-domain evidence, preserves all track files, resolves an unambiguous text candidate when possible, and queues media jobs.

### Media drain

`audio-track` performs resumable ranged acquisition, checks source identity and SHA-256, measures duration, and uploads the exact prepared bytes to R2. Once that succeeds, the recording is playable. If a text pairing exists, a separate content-addressed alignment job is queued.

### BioSync drain

`audio-align` fetches the prepared R2-backed audio through Cove, checks the checksum again, pins/verifies the matching EPUB, runs ASR, validates exact EPUB word locations and only then publishes the timing map.

Alignment failure moves independently through retry/review. It never rolls back playable audio.

Before downloading a transcription model, the Python worker requests its file
manifest, pins the returned model revision, and counts only files absent from
the local cache. It requires the missing bytes plus 96 MiB of working space.
Downloads use the regular Hugging Face HTTP path, one file at a time. A model
which cannot fit moves its alignment job to `review`; source/network failures
retain normal retries. The worker does not replace the requested model with a
less accurate one or publish unverified timings. In particular, the larger
`small.en` fallback can require a worker with more storage than the Vercel
runtime. Resume those reviewed jobs only after providing sufficient capacity.

The private audio service's `GET /health` returns a JSON diagnostic object and
HTTP 503 if its backend credentials are missing. This checks configuration,
not live connectivity to D1/R2 or the completion of a transcription.

After changing the audio runtime, verify one Pride and Prejudice alignment job
through `audio_timing` and its R2 map before restoring broad alignment/discovery
schedules. Some previously paused jobs have `next_attempt_at` set in 2099;
release only the chosen canary initially and leave their attempt history intact.
If Vercel rejects builds because of its deployment limit, the committed Python
fixes are not live until a subsequent successful production deployment.

Runtime regression checks (no model weights or backend credentials needed):

```sh
python3 -m pip install 'fastapi==0.141.1' 'vercel-queue==0.9.0' 'huggingface-hub>=0.21,<2' httpx
python3 -m unittest discover -s scripts/audio_pipeline/tests -v
node scripts/check-catalog-fetch.mjs
```

### Lease semantics

Audio jobs are leased in D1. Workers heartbeat every two minutes; a lease is ten minutes. Expired jobs can be reclaimed, attempts are bounded, retries use backoff, and repeatedly failing jobs move to review.

## 9. Cron cadence

### Production Worker plan

Run the persistence backend on a paid Cloudflare Workers plan for production. Cove's authenticated API, catalog projection, search/taxonomy synchronization and scheduled ingestion are not designed around the Free plan's tiny CPU allowance. The schedules remain bounded and network-heavy work does not count as CPU time, but the persistence owner is still a real application backend rather than a static edge shim.

Current defaults:

| Job | Schedule |
| --- | --- |
| eBook catalog batches | every 5 min |
| audio bulk/daily scan | 03:17 UTC daily |
| audio discovery drain | every 10 min; pause while at least 96 tracks are pending |
| audio media drain | every 5 min |
| BioSync alignment | minute 23 hourly |
| recommendations/publishing maintenance | 04:41 UTC daily |

These are deliberately staggered. Increase batch sizes only after observing upstream rate limits, D1 write load, R2 traffic and Vercel active CPU.

Discovery backpressure does not trigger alignment. The hourly alignment schedule
can remain disabled during BioSync recovery while discovery and track preparation
continue independently.

## 10. Rollback

The gateway makes rollback simple:

1. Keep the prior Vercel deployment available.
2. If the backend cutover misbehaves, remove/disable `FORE_BACKEND_URL` on a preview deployment first; public-domain GETs continue through Cove's stateless adapter.
3. Do **not** remove the backend URL in production while accepting account/commerce writes; those are intentionally fail-closed without persistence.
4. Roll back the Vercel deployment or backend Worker independently. D1/R2 data remains in place because deploys do not recreate resources.

## 11. Verification gate

The persistence-specific CI gate verifies the changed TypeScript surfaces with ESLint, runs `test:persistence-backend`, compiles the Python worker modules, builds the Vercel application, and independently bundles the persistence Worker.

The repository's broader supply-chain workflow is intentionally separate. For commit `2111654`, its dependency audit and secret scan passed, but repository-wide static analysis failed. The modified legacy `api.server.ts` had the same 869 lint errors as its parent before the follow-up import-format cleanup; the new catalog retry module passed ESLint. The separate `persistence-backend` workflow passed the catalog retry regressions, Python runtime regressions, and both deployment builds. Do not treat that focused gate as a passing repository-wide security workflow.

## 12. Future evolution

If Cove later moves off D1/R2, put the replacement behind the same persistence boundary first. The public app should not gain direct vendor-specific database calls. That keeps a future Turso/Postgres/Blob migration isolated to one backend instead of re-coupling the UI and domain code to hosting infrastructure.

## Production checkpoint — 2026-10-11 07:15 UTC

- Fix commit: `2111654fce0bf5d4cc438c55929e9a199932b791`.
- Cloudflare Worker version: `8c112fba-3af6-49cf-b4e1-a66f1b3984a8`, deployed at 06:59:50 UTC. The prior version is `bb6d1549-db12-4639-85d4-b2036f2281ce`. Existing bindings, secrets, and limits were preserved.
- Vercel reported a successful deployment: `dpl_DgVrxMAshq3rVBJLuQEigzWjtq8r`. Its earlier build-limit rejection no longer describes this release.
- Latest observed inventory at 07:14 UTC: 2,416 normalized works, 69 completed track jobs, and 129 queued track jobs. All 35 Pride and Prejudice tracks were prepared. `audio_timing` still contained zero maps at 07:15 UTC.
- Active Cloudflare schedules were restored to `*/5 * * * *`, `17 3 * * *`, and `41 4 * * *`. The ten-minute discovery/alignment and hourly alignment schedules remain disabled.
- A temporary ten-minute trigger received HTTP 200 from `audio-align` at 07:10:08 UTC, but no alignment job was claimed during the following five minutes. The selected job, `align-pg-20686-01-843723ef63d63aa5`, was returned to its prior `2099-01-01T00:00:00.000Z` pause; its three previous attempts and error history were preserved. No alignment lease remained active.
- Queue acceptance is not evidence of transcription completion. The accepted queue message may remain retained for six hours; inspect its delivery state before issuing another test. The subscriber configuration matches the Python SDK documentation and imports successfully locally, but live consumer execution remains unverified.
- The connected Vercel account returned team/project access errors (HTTP 403) when reading this deployment and its protected URL. The affected project is `prj_bq7hKQw8JKWE6vpfdOgwowa8cjjM` under `team_CfIbAlLf4fFzRdoPtD3eOeai` (`jibrilmohamuds-projects`). Restore authorized runtime access, inspect the deployed queue consumer and its errors, and verify one stored timing map before restarting broader alignment.

## Discovery recovery — 2026-10-11 16:51 UTC

- At 16:48 UTC, the catalog contained 5,337 normalized works; 182 track jobs were done, 15 queued, and one running. There were still no timing maps. Discovery had 931 queued jobs, so leaving its schedule disabled would eventually stop new audiobook intake.
- Discovery backpressure now only pauses discovery. It no longer submits an alignment request when 96 or more tracks are pending. Alignment retains its independent hourly trigger.
- Cloudflare Worker version `f2ade63f-99f1-4c38-8f96-69c082bf8221` was deployed at 16:51:22 UTC, preserving all bindings and runtime settings. Roll back to `8c112fba-3af6-49cf-b4e1-a66f1b3984a8` if necessary, and disable the ten-minute schedule when rolling back because that version couples discovery backpressure to alignment.
- The ten-minute discovery schedule is active again, alongside the existing catalog/media, scan, and maintenance schedules. The hourly `23 * * * *` alignment schedule remains disabled. The first restored discovery tick has not yet been observed at this checkpoint.
- Verification passed: the backend architecture checks, Worker build, targeted ESLint, and an execution check of the compiled scheduled handler. With 95 pending tracks it invoked discovery; at 96 and 200 it invoked neither discovery nor alignment; the separate hourly trigger still selected alignment.
- The Vercel connection's deployment-context lookup returned an empty team list at 16:48 UTC. Runtime access remains the blocker to diagnosing why accepted queue requests do not claim BioSync jobs. Do not mark BioSync operational from deployment success or queue acceptance alone.
