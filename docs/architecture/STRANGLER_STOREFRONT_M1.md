# Cove architecture migration — M1: independent anonymous serving boundary

Status: **IMPLEMENTED AS A NON-DEPLOYED EVALUATION CANDIDATE; COMMERCIAL NO-GO**.

This clean-main integration branch ports the previously measured thin storefront concept
from experimental PR #227 without merging its stacked parent branches. Production
SSR, D1, checkout, reader, ingestion, routing, secrets and scheduled jobs are unchanged.

## Execution/data boundary

- A separate Worker handles only authenticated staging GET `/` with no query
  and a protected bootstrap diagnostic. It must see immutable Cloudflare
  country metadata before it reads the current primary D1 legal-rights shelf.
- It reuses the existing canonical anonymous bootstrap; the same current
  rights predicate and rate-limiter decision must complete before rendering.
  It cannot cache grants, authorized product IDs or complete HTML.
- All account, commerce, reader, filtered-search, asset and API routes
  delegate through the `CORE` service binding. Any identity/session hint
  forces the established application path.
- It intentionally has no R2 bucket or direct payment/identity credentials.
  The checked Wrangler config contains only a historical wholly synthetic
  isolated D1 ID, a rate limiter and a staging core binding.
- The Wrangler config is unroutable (`workers_dev=false`,
  `preview_urls=false` and no custom routes), and the runtime requires a
  staging secret, an explicit evaluation flag and the isolated fixture ID.
  No automatic CI deployment is permitted.

## Nonnegotiable release debt

The lightweight HTML is an **architectural prototype**, not a replacement for
the complete Cove storefront. It lacks full in-place saves, market controls,
merchandising, literary discovery form behavior, offline controls and React
interaction parity. It is not approved for customer routing. The historical
PR #227 passed two 50-RPS short synthetic trials but **failed 100 RPS**.

## Acceptance milestones

1. M1 — clean-main independently bundled Worker; no forbidden app imports;
   four-territory ordered canonical live-rights parity; fail-closed revoked
   grants, database outage and read limiter; identity/route fallback; stage-only
   config. This PR is the start of M1; CI must prove completion.
2. M2 — extract a stable presentation projection and rights-authority
   interface without changing primary rights semantics. Avoid SQL-wide
   discovery, uncapped counts and bulk impression writes on a first paint.
3. M3 — restore full production homepage UI and keyboard/mobile/a11y parity
   through a bounded hydration plan and same-origin assets.
4. M4 — physically separate content ingestion, discovery models, telemetry
   and commerce authority; use a durable outbox, bounded queues and idempotent
   reconciliation. No cross-D1 eventual state may authorize an access grant.
5. M5 — independent multi-region cold and sustained 25/50/100-RPS mixed
   tests with background producers active, 1/4/8/16/32-request concurrency,
   rights revocation, checkout/reader/audio and field/lab LCP evidence.
6. M6 — operator-approved production cutover with verified domain, secrets,
   Stripe/Supabase callbacks, rollback and alerts. Keep Vercel until then.

## Rollback

This evaluation branch does not modify main or expose a Worker route. Abort
it by closing its PR. A later cutover must explicitly preserve the existing
app route and independently verified production database recovery path.

## M2 prepared catalog branch (off by default)

A new `storefront-strangler/prepared-catalog.server.ts` contains a separate
private candidate producer and reader contract. Producers prepare at most 128
currency-appropriate popularity-ranked IDs per market and publish expiring
non-authoritative snapshots to a private object store. Request-time resolution
**must** run a fresh, bounded primary D1 query against the exact existing
`retail_product_availability_rows` view, current market currency, product
activation, suppression, and edition release conditions. Revocations apply
on the next request; no cached grant or entitlement authorizes access.

The opt-in `COVE_STRANGLER_READ_MODEL=1` requires a private
`PRESENTATION` binding and is intentionally absent in the nonroutable
Wrangler file. No source publishes models automatically; an independently
isolated job worker and dedicated R2 binding must be explicitly provisioned
and integration tested before enabling it. If the model is missing, expired,
malformed, mismatched or the primary authority fails, the request fails
closed without falling back to 50,000-row D1 rankings. The legacy unflagged
bootstrap remains untouched. The candidate shortlist may not include every
newly ranked book until refresh, so ranking/pagination parity must be proven
before the opt-in can serve customers. This is NOT a rights or LCP certification.

## M2 dedicated producer execution

A separate `producer.worker.ts` now consumes the private snapshot writer and
reads a bounded active-market list in an **out-of-band scheduled execution**.
It cannot handle HTTP storefront requests and its checked deployment
configuration has no public routes, preview URL, or automatic cron. The
producer's synthetic D1 and private R2 binding have no production data; the
named R2 staging bucket is a required resource to provision before deployment
and is not assumed to exist. Only explicitly scheduled operator testing can
publish candidate projections. End-to-end live capacity is still unproven.

## Staging delegation and sparse-market candidate correctness

The producer now filters candidate hints by the current territorial retail
availability view **before** taking the top 128, preventing licensed books
from disappearing behind a global popularity cap in sparse countries.
This derived candidate data never grants rights: the serving Worker still
performs one fresh bounded authoritative primary-D1 validation, including
immediate revocation. The gateway also strips its staging operator bearer
before delegating account, reader, checkout, or navigation to CORE while
preserving customer session cookies. Dedicated regressions cover both.

## M4 stage-only operational metric isolation

An optional Analytics Engine writeDataPoint binding now replaces the **general
HTTP timing aggregate only** for a strict allowlist of successful anonymous
GET API responses. It never writes query strings, identity, IP, cookies, product
IDs, tokens, or private routes. Every error/status other than 2xx, authenticated
request, checkout, reader, and security-sensitive endpoint continues using the
existing D1 HTTP/trace/metric records. Consent- and erasure-sensitive search
and recommendation attribution is NOT rerouted by this change; those flows
require a separate durable consumer and an audited consent/erasure model.

The opt-in requires `COVE_SSR_STAGING=1`,
`COVE_OPS_TELEMETRY_MODE=analytics-engine`, and an explicitly provisioned
`OPS_ANALYTICS` Cloudflare binding. None is configured by this PR, so the
existing runtime behavior remains unchanged. Test coverage verifies all guard
conditions and non-PII metric content. Hosted D1 contention savings remain
unmeasured, and no change should be merged solely on this experiment.

## Read-only infrastructure readiness gate

The `strangler-data-plane-preflight` workflow checks the **existing**
synthetic D1 ID, private stage R2 bucket and staging CORE service through
Cloudflare's GET-only control-plane API. It requires the account's existing
staging CI token but cannot create, deploy, schedule, mutate or route anything.
A failed or inaccessible resource is a **release blocker**, not permission to
reuse production D1 or create an unrestricted public Worker. Even a green
preflight does not constitute hosted capacity, full feature parity, Stripe
sandbox or protected audio acceptance.

## Controlled private staging bucket creation

An account- and branch-scoped CI workflow may create the **one exact private
staging R2 bucket** `cove-strangler-private-presentation-stage` if and only
if the preexisting isolated D1 identifier verifies first, the bucket returns
404, and the operator's CI token has R2 write permission. The workflow cannot
modify D1, deploy Workers, configure custom/public domains, set cron, or change
production routing. Existing buckets are reused. This creates infrastructure
capacity only; candidate snapshots and production traffic remain untouched.

## Private real application CORE pilot

`wrangler.storefront-core.stage.toml` configures Cove's actual native
TanStack SSR server (not a dummy CORE) using the isolated synthetic D1
fixture. It is **nonpublic**, with workers.dev and preview URLs disabled,
no production media/payments binding, and a distinct random bearer gate
secret. A tightly scoped PR workflow can deploy this real private CORE to
allow the thin evaluation Worker to delegate authenticated navigation once
an explicit internal credential handshake is added. This first deploy does
not itself enable the public thin Worker or route customer traffic. In
particular checkout, reader/media and audio cannot be certified until a
fully seeded production-equivalent environment exists.

## Private service-to-service gate handshake

The thin gateway strips the inbound staging bearer before delegating to CORE.
The private CORE's *different* `COVE_SSR_STAGING_GATE_KEY` may be supplied
to the thin Worker as `COVE_INTERNAL_CORE_STAGE_GATE_KEY`, installed only as
a Worker secret during paired staging deployment. The inbound token is never
forwarded. A malformed or reused key fails closed with 503; customer session
cookies remain intact. This handshake does not enable customer traffic or
turn the read-only staging API into a writable production checkout.

## Hosted runner build/config path and cleanup correctness

The ephemeral Wrangler configurations live in `.output/strangler`, so their
`main` fields must be `index.mjs` and `producer.mjs` respectively.
Separate checked JavaScript programs construct the producer-activation,
producer-disable, model-enablement, and real-model readiness operations.
This avoids fragile nested YAML/Bash heredocs that previously broke cleanup.
The operator-dispatch-only CORE and bucket provisioning workflows never
re-rotate their credentials on unrelated pull-request commits.

## Independent stage seed (not a scheduled-producer release proof)

New Cloudflare cron schedules may require up to 15 minutes to propagate; a
fresh 5-minute cron followed by a 390-second wait cannot establish actual
catalog readiness. The protected hosted capacity harness now seeds all active
markets from a **read-only synthetic D1** candidate query into the named
**private staging R2** bucket, independently verifies the US R2 object,
and only then runs its live-primary-rights storefront readiness test. This
avoids conflating cron propagation with request TTFB. The candidate validity
window is 20 minutes; legal rights still revalidate at each request. Empty
territories produce empty candidates, never forged rights or offers.

The scheduled production-like publisher remains a separate unproven release
gate, as do ingestion-under-load, complete store UI parity, checkout, reader,
audio and live 100-RPS capacity. No production data or route is modified.

## Correlated latency and independent failure collection

The protected stage now has a fixed 200/"ok" transport-control response,
which requires the same ingress bearer but performs no D1/R2 operations.
The 1/4/8/16/32 and 25/50/100-RPS harness records bootstrap and catalog
Server-Timing alongside end-to-end TTFB and a non-bootstrap residual.
**Residual is not automatically network latency**: it also contains
unmeasured Worker dispatch/runtime, ingress and client effects. Independent
native and HTTP/2 suites run even if one cold round fails. The final gate
requires all 3 cold rounds plus every offered/valid response, both protocols,
strict 800-ms maximum and 650-ms p95 targets; no failure is hidden.
