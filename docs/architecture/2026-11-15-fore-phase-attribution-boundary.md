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
