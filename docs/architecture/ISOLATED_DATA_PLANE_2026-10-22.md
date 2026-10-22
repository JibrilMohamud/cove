# Isolated presentation and preparation data planes

Release status: NOT CERTIFIED. All new production switches remain off.

This integration brings the dual-D1 groundwork from #249/#247 onto current
main without restoring their old storefront, dependencies, or request runtime.
It preserves main's live rights authority, indexed facets/ranking isolation,
interactive renderer, CORE delegation and hard-capped customer gateway.

## Implemented serving boundary

`COVE_STRANGLER_READ_MODEL=2` loads a private, country-specific versioned R2
object containing up to 128 advisory product IDs, bounded card metadata
(title, author, genre and cover only), and anonymous presentation contexts for at most 16 locales. The publisher reuses canonical locale/message/
page resolution; code-owned UI strings are rebuilt rather than duplicated.
Snapshots expire within 20 minutes and no later than a selected page's end.
Publication is one atomic object replacement. There is no cross-request pending
I/O, hedged read, legal decision cache or primary microbatch in this path.

One fresh primary D1 SELECT resolves active currency, active product/release,
availability/suppression, current retail territorial grants/deny precedence,
and live display offers in the active currency. Materialized, bounded candidate
IDs drive indexed product lookups. The authority never hydrates authors, works,
covers, series or other presentation metadata: those come from independent
discovery/R2. At most 25 eligibility/offer rows yield a 24-book page. Snapshot
offers and subscription/library flags are explicitly ignored. Revoked items are filtered immediately even when discovery remains stale.
A missing, invalid, oversized, expired or wrong-market projection fails closed;
there is no global 50,000-book fallback on the fast route.

The isolated v2 producer has only DISCOVERY_DB and private PRESENTATION bindings.
Its checked staging config reads the separate synthetic control database; it
has no primary-rights or transaction database binding, public ingress, automatic
schedule or enabled flag. The older v1 candidate producer remains an evaluation
compatibility path; it is not the v2 serving architecture.

Discovery synchronization is still an operational release prerequisite: the
staging control database is a fixture, not a live production event feed. A
production discovery owner must consume versioned catalog publication updates,
handle replay/rebuild, and prove freshness/parity before binding this producer
to real catalog data. This integration does not pretend that a fixture is CDC.

## Preparation and telemetry boundaries

The imported groundwork provides independent CONTENT_DB claims, private EPUB
preparation, fenced budget reservations, idempotent primary outbox handoff and
rights-checked nonpublic evidence publication. Existing canonical customer
profile publication remains authoritative. No migration from `infra/` is
implicitly applied to production.

An optional Cloudflare Queue now carries content-addressed job wakeups. The
primary outbox ACK follows both the durable independent enqueue and successful
queue send. Lost sends or ACKs retry the same ID. Queue execution claims exactly
the notified job with a lease, acknowledges terminal duplicates, delays leased/
not-yet-due jobs and backs off service failures. Queue delivery never supplies
source URLs, grants, credentials or bytes. Checked staging configuration caps
consumer concurrency and batch size at one, retries four times, and uses a DLQ.
The independent D1 queue remains the durable status/recovery ledger.

Successful allowlisted anonymous API timing aggregates can opt into Analytics
Engine in staging. Errors, identity, commerce, security records and consent-
sensitive event attribution retain existing durable behavior. Sink failure
never redirects the aggregate into a primary-write retry storm.

The legacy scheduler externalization switch is available but OFF. Do not run
the old and new production owners simultaneously. Claims, AI analysis scheduling
and canonical profile publication have not all migrated to a new production
owner merely because the private preparation lane is complete.

## Validation and release gate

Local tests verify 16 country/language combinations against the existing
bootstrap, exactly one primary query per v2 request, indexed lookup query plans,
stale-discovery revocation, missing/expired/invalid snapshot rejection, two
independent SQLite domains, lost queue-send replay, lease/backoff, existing
rights/commerce, budget fences and prepared-result publication. Typecheck,
independent serving/content builds, targeted lint and secret scanning are run.

`isolated-data-plane` CI runs correctness before a protected hosted campaign.
The campaign uses a single immutable revision, distinct primary/discovery/content
staging databases, three uniquely deployed first-execution cold Workers,
D1-free transport and presentation-only controls, 1/4/8/16/32 bursts, then matched
canonical/projection/projection/canonical 120-second 100-RPS phases. Independent
content writes and discovery ranking reads run in each phase. It retains raw
responses, invalid/error latencies, scheduler drops, D1 SQL/service/retry/region/
primary attribution, background failures and cleanup outcome. No failed cold
trial aborts collection of later diagnostics. Projection phases require 12,000
valid responses, zero dropped arrivals, p95 <600ms, p99 <750ms and max <800ms.

Campaigns use distinct run-scoped R2 namespaces so a real-data seed cannot
replace a synthetic campaign snapshot. Staging Workers use an explicit
`aws:us-east-1` placement hint, based on observed ENAM/IAD primary execution;
`x-cove-stage-placement` records actual placement when supplied by Cloudflare.
This is a staging experiment, not proof that physical placement cures service
waits or a production placement change. Cold measurements never warm the Worker.
Superseded campaigns retain partial evidence and clean their own Workers on
SIGINT/SIGTERM; cancellation is not a performance PASS.

These background SQL workloads are synthetic load attribution, not certification
of real ingestion, authenticated checkout, entitled reading or protected audio.
A single runner's observed colos do not establish independent multi-geography
coverage. Complete signed Vercel QA, Cove sandbox payment/entitlement flows,
visual mismatch <10% on mobile and desktop, LCP, mixed real workloads, rollback
rehearsal and repeated real-primary cold/service tests remain mandatory.

No production route, customer flag, signing key, rights grant or entitlement is
changed by the new workflow. Hosted candidate Workers are deleted in finally;
failed cleanup fails the run. Merge still triggers the repository's existing
production backend deployment, so this integration must remain draft until the
whole release contract passes. A green architecture test is not release approval.

## Initial measured outcome (before display hydration was isolated)

Run 39722114860 (source b49be248) used four 120-second 100-RPS phases with
independent background domains. The two projection phases returned all
12,000/12,000 responses, with p95 229/220ms and zero drops. One maximum was
1,646ms (FAIL); the other was 715ms. Reversed canonical phases reached p95
388/1,102ms, maxima 1,397/2,891ms, with 2/1 invalid responses. This supports an
improvement but not strict repeatability. The 1,646ms projection outlier had
1,569ms primary D1 service time versus 4.5ms actual SQL, one attempt, ENAM primary.
D1-free transport max was 137ms; presentation-only control max was 180ms.

Real-primary run 39722787569 (source d2da15b6) failed cold at 1,030/1,898/361ms;
the worst primary service time was 1,576ms versus 11ms SQL. Mobile p75 LCP was
432ms with CLS 0; mobile visual mismatch was 10.72% and desktop 22.41%, both
FAIL. All 24 edition links matched. These failures are retained and cannot be
waived by the subsequent lean-authority/placement implementation. New same-
revision hosted results are mandatory.

The connected Supabase Cove project currently has one registered user and no
user marked as dedicated Cove QA. The connected Stripe sandbox is named Ko-fi,
not Cove; no checkout is charged to that unrelated account. No reusable QA login
session or Cove sandbox checkout/entitlement journey has been certified.
