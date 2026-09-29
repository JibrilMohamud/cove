# Vercel persistence backend and ingestion runbook

## Why Cove keeps D1/R2

Cove already has a large SQLite/D1 schema covering normalized catalog identity, storefronts, accounts, rights, commerce, finance, publishing, moderation, recommendations, search fallback, synchronization, operational queues, audiobook jobs and BioSync. It also has R2 object-key contracts for EPUBs, publisher assets, audio media and content-addressed timing data.

The safest Vercel migration is therefore an **application migration, not a data-engine rewrite**:

- Vercel owns public web/SSR and scheduled orchestration.
- The dedicated Cove persistence Worker owns D1/R2 and runs the existing domain API.
- The public origin is still Vercel.
- D1/R2 remain authoritative until Cove intentionally performs a separate data-store migration.

This avoids translating FTS5, SQLite JSON expressions, RETURNING/UPSERT behavior and more than forty ordered migrations into another SQL dialect during the hosting move.

## 1. Prepare the persistence Worker

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

Do not manually set:

```text
COVE_APP_INTERNAL_URL
COVE_AUDIO_PIPELINE_URL
```

Those are Vercel service bindings.

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

### Lease semantics

Audio jobs are leased in D1. Workers heartbeat every two minutes; a lease is ten minutes. Expired jobs can be reclaimed, attempts are bounded, retries use backoff, and repeatedly failing jobs move to review.

## 9. Cron cadence

Current defaults:

| Job | Schedule |
| --- | --- |
| eBook catalog batches | every 5 min |
| audio bulk/daily scan | 03:17 UTC daily |
| audio discovery drain | every 10 min |
| audio media drain | every 5 min |
| BioSync alignment | minute 23 hourly |
| recommendations/publishing maintenance | 04:41 UTC daily |

These are deliberately staggered. Increase batch sizes only after observing upstream rate limits, D1 write load, R2 traffic and Vercel active CPU.

## 10. Rollback

The gateway makes rollback simple:

1. Keep the prior Vercel deployment available.
2. If the backend cutover misbehaves, remove/disable `FORE_BACKEND_URL` on a preview deployment first; public-domain GETs continue through Cove's stateless adapter.
3. Do **not** remove the backend URL in production while accepting account/commerce writes; those are intentionally fail-closed without persistence.
4. Roll back the Vercel deployment or backend Worker independently. D1/R2 data remains in place because deploys do not recreate resources.

## 11. Future evolution

If Cove later moves off D1/R2, put the replacement behind the same persistence boundary first. The public app should not gain direct vendor-specific database calls. That keeps a future Turso/Postgres/Blob migration isolated to one backend instead of re-coupling the UI and domain code to hosting infrastructure.
