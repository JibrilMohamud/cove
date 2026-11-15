# Production FORE first-paint failure attribution: guarded diagnostic release

**2026-11-15. PR #705 direct to main; draft, no deployment.**

## Observed production incident

Vercel production runtime logs on November 15 still show customer-visible
503 warnings on `www.covereads.com` (homepage/bootstrap at ~22:17 UTC)
and `cove-puce-theta.vercel.app` (catalog/taxonomy/page/context at
~22:25 UTC). The failure text is largely
`worker-api pre-context handler-exception`, with occasional
`post-context catalog-rights`.

**This label is not a root cause.** First paint concurrently starts
context, catalog, markets, admissions and page work. Failure before
a completed context marker can originate from another parallel phase.
The Vercel runtime-error aggregation reported zero exception clusters
while warning logs explicitly recorded 503s, so only counting exceptions
would miss the incident.

## Minimal reviewed producer-to-consumer contract

- Worker source `src/features/fore/api.server.ts`: for FIVE hardcoded
  first-paint promise phases only, the `timed()` catch appends
  `cove_fault_context`, `cove_fault_catalog`,
  `cove_fault_markets`, `cove_fault_limit` or `cove_fault_page`
  as a numeric `Server-Timing` marker, preserving the original rejection.
- Vercel boundary `src/lib/persistence-backend-failure.ts`:
  parses only the fixed five names and duration-1 numeric form from an
  authenticated Worker response. Unknown, multiple, inconsistent, absent
  and unauthenticated markers remain `unknown`.
- No error message, request identity, SQL, customer input, user token,
  arbitrary dynamic phase string or stack is serialized into the marker.
- Markers classify where a failed promise rejected, not necessarily the
  causal D1 SQL statement. Additional owner/binding tracing will still
  be required.

## Canonical writer fingerprints remain unapproved

The same API file retains 33 previously reviewed direct SQL mutation
sites. Their source `siteId` and line fingerprints were updated
solely for the fixed diagnostic code offset, with no SQL or enclosing
writer semantic change. Every one remains
`owner-command-required`, `productionOwnerGuarded=false`,
`releaseApproval=false`. The canonical writer closure audit must
pass on the direct-to-main PR merge comparison.

## Production telemetry and D1 write amplification review

Read-only Cloudflare API check found that the **production persistence
Worker has no `observability` settings**, no logpush and no tail
consumers. Cloudflare Observability had records from the separate
production legal owner, but none from the persistence Worker in the
sampled 22:20–22:35 UTC window. That is a telemetry coverage gap,
NOT proof that the backend did not run.

The production Worker **already** has a purpose-scoped independent
Analytics Engine binding `OPS_ANALYTICS` to `cove_public_http_ops`;
its canonical production toggle is `analytics-engine` and public
anonymous HTTP instrumentation is enabled. Previously that sink
accepted ONLY successful anonymous GETs. The additional minimal
diagnostic writes fixed `["public-api-failure", route, "5xx"]`,
status code and elapsed milliseconds for failed anonymous GETs on
six reviewed public read routes. It excludes cookies, authorization,
identity headers, all non-GET routes, commerce, rights and user requests.
**No URL query string, title, book ID, user ID, IP, error body, SQL,
exception text, request ID or authentication secret is emitted.**

Most importantly, the failure-metric branch **returns false** after
its best-effort AE write, so `handleCoveApi` continues to call
`recordHttpRequest` and retains existing primary-D1 operational/
security/error audit behavior. This is not a substitute for certified
legal records. If Analytics Engine fails, the original 503 and D1
error audit behavior remain unchanged.

The existing `recordHttpRequest` writes up to three ops D1 records
per request (request, trace and histogram) in one batch. Read-only
D1 audit sampling at 22:20–22:30 UTC had four successful recorded
public requests and no recorded 503s, even though Vercel logged many
503 warnings in the same period. This is a **cross-system signal gap**,
not conclusive proof of a D1 auditing failure or of its root cause.
Do not drop required legal/security logging or assume this stage
instrumentation resolves D1 contention.

A future controlled release must verify independent AE category
counts, Worker phase markers and actual 503 rate before and after
deploying, with no automatic fallback to stale catalog rights.

## Independent validation and deployment boundary

PR #705 was retargeted to `main` and GitHub reported
`mergeable_state=clean` with six changed files. The latest PR
merge-based checks, not only its earlier staged-base checks, must pass
before considering a dedicated, rollbackable canary. The canary should
collect fixed-marker frequencies on no-payment catalog endpoints,
and compare baseline 503 counts with identical traffic while keeping
production legal-owner flags, D1 grants, payments and routes unchanged.
No customer routing or runtime configuration was altered here.

**This diagnostic itself cannot certify zero production 503s or
four-region performance. It is necessary causal evidence to fix them.**
