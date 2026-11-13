# Staging public display cache

The November 13 owned-canary campaign for main `242e3712` still failed:
32 cold visitors reached 1,007 ms, and the two 100-RPS phases returned 897
and 973 HTTP 503 responses. Every captured 503 carried the fixed catalog
service-overload label. The label identifies a failure class, not an exact
provider error or the individual failed statement in a D1 batch. Production
routing and production owner activation remain unchanged.

## Change and authority boundary

Only the staging lean anonymous bootstrap supplies a public-display cache
scope. Completed title, byline, description, genre and cover data can live
for at most 30 seconds, keyed by D1 binding plus canonical product and edition.
The explicit presentation allowlist excludes canonical product/edition/work
identities, sourceName/sourceExternalId, offers, rights decisions, DRM,
downloadable status, reading availability and protected EPUB links. Only
serialized JSON data crosses requests; promises, responses and D1 statements
do not. Limits: 128 entries, 1 MiB total, 64 KiB per entry, with expired and
oldest-entry eviction. Uploaded books are rejected.

Every visit still executes the original candidate CTE on primary D1, with
unchanged live market currency, ranking, territorial rights, contract, denial
and availability predicates. The compact projection obtains current IDs,
source identity, retail offer, release/DRM/download settings and EPUB state.
Secondary subscription/library eligibility remains absent from this preview,
as before. Cached display data never authorizes any action.

A cold cache uses the unchanged full query. If any currently selected edition
has no usable display entry, the complete original query runs again, using
its newly current selection; a newly approved book cannot be dropped to fit
an older cached shelf. Failure of primary D1 always propagates. Non-staging
callers retain the original full read. This does not solve first-ever cold
bursts; its purpose is to reduce repeated primary hydration under load.

## Measurements and validation

Three alternating read-only production D1 API measurements returned 25 rows
for each projection. The original query read 1,030 rows and returned 67,062
JSON characters; the compact query read 530 rows and returned 16,600 characters.
SQL durations were 9.69/6.96/8.45 ms full and 6.91/3.94/7.27 ms compact. These
are query measurements, not hosted throughput or geographic certification.
No database rows were written.

The new regression compares complete warm/cold card JSON and ordering against
the original query, across five markets. It changes live prices, DRM,
downloadability, EPUB availability, grants and storefront withdrawal; verifies
immediate grant expiry; adds a newly approved book; checks primary failure,
missing/expired display fallback, cross-edition/scope isolation, immutable
copies and memory bounds. Existing Worker request-lifetime, request-batching,
bootstrap, recovery and hedging regressions remain mandatory.

Rollback is an ordinary source revert of this staging-only path. No binding,
quota, payment behavior, rights gate or customer routing change is required.
A fresh protected canary campaign must still establish any hosted improvement;
all strict response validity, zero-drop and latency requirements remain intact.
