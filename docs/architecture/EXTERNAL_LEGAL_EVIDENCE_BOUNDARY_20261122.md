# External legal evidence review — November 22, 2026

Release remains **NO-GO**. No genuine source withdrawal archive or independently
established rightsholder authority was obtained in this review. No production
grant, owner setting, database binding, payment, deployment or route was changed.

## Engineering correction

The offline chain verifier previously accepted a correctly signed checkpoint
claiming exhaustive coverage through a future date. Its original positive test
fixture even used the end of the review day. A signature cannot establish that
future withdrawals have all been received.

The reviewer must now supply `requiredCoverageFrom` and
`requiredCoverageThrough` independently of the archive. Both must be canonical
UTC dates, ordered, and no later than the evaluation clock. The signed checkpoint
must cover that entire requested interval and must not extend into the future.
The report records the requested interval and evaluation time; its schema is v2.
An old archive may be reviewed for a historical interval, but that does not
establish present completeness. A source cannot select its own review cutoff.
The injected clock exists for deterministic offline tests; it is not an
authenticated production time attestation.

All authority, reconciliation, owner-epoch, writer-exclusivity, publication and
release flags remain false. `externalWithdrawalHistoryComplete:false` is now
explicit even after every cryptographic check passes. No serving route imports
this module, so this change adds no customer request work.

## Genuine external material found, and its limits

Official policy pages reviewed:

- <https://www.gutenberg.org/policy/permission>: the retrieved official search
  content distinguishes US public-domain material from copyrighted material;
  Gutenberg cannot sublicense copyrighted works on the rightsholder's behalf.
  A direct page fetch returned HTTP 503 during this review, so no successful
  direct-fetch claim or immutable legal-document capture is made.
- <https://www.gutenberg.org/policy/license>: the retrieved official search
  content requires examination of the license inside each ebook; the catalog
  may be wrong. A direct fetch also returned HTTP 503.
- <https://gutenberg.net.au/licence.html>: successfully retrieved official policy
  states that some works have copyright-holder restrictions, national scope
  matters, and commercial modifications have additional conditions. The page
  labels its last update May 10, 2021. Retrieval today does not make that a new
  grant or a historical withdrawal ledger.

These are policy context, not per-work adjudications, authenticated external
event histories, or proof of the absence of withdrawals. No assumption is made
that every public-domain work requires a newly signed rightsholder permission.
The signed-chain protocol is one evidence-integrity tool, not a substitute for
reviewing the actual legal basis or a requirement that a provider manufacture
Cove-specific signatures. Other genuine records require an independently
reviewed provenance and reconciliation method before use.

The available file searches returned project instructions and unrelated material,
not a usable withdrawal archive. That search result does not prove no such
archive exists elsewhere. No provider or rightsholder was contacted.

## Read-only production observations

Cloudflare settings and active deployment metadata were read at
`2026-11-22T14:00:20.535Z`:

| Requirement                        | Observed evidence                                                                                                                  | Status                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Enabled lawful production owner    | `cove-legal-authority-production` has `COVE_RIGHTS_OWNER_ENABLED=0`; version `3463ff93-f077-40bf-a4d5-fb7bfc143cd5` serves 100%    | BLOCKED                 |
| Exclusive primary D1 writer        | Both that owner and `cove-persistence-backend` retain native bindings to the same primary database                                 | BLOCKED                 |
| Production backend candidate       | Backend still serves `401f2af2-6e69-4611-8110-1d127af6eecf` at 100%                                                                | VERIFIED metadata only  |
| EPUB operator activation           | No `FORE_REGIONAL_EPUB_REPAIR_ENABLED` plain-text binding appears in backend settings; no repair executed                          | BLOCKED                 |
| Source history integrity           | Offline adversarial tests exercise future, stale and missing coverage as well as existing sequence/signature/reinstatement denials | VERIFIED synthetic only |
| Dependency security                | Current unchanged lockfile audit reports zero vulnerabilities of every severity                                                    | VERIFIED audit only     |
| Historical production rights       | Previously recorded replay has 116 disputed histories, 114 unverified reactivations and two backdated events                       | BLOCKED; not rerun here |
| LIVE fulfillment/revocation        | No LIVE transaction or refund executed in this review                                                                              | BLOCKED                 |
| Storefront reliability             | No customer probe, backend deployment or reliability observation window in this review                                             | BLOCKED                 |
| Production-compatible rollback     | Existing protected synthetic TEST rehearsal does not establish production compatibility                                            | BLOCKED                 |
| Geographic and 100-RPS performance | Deferred behind legal/correctness gates; acceptance unchanged                                                                      | BLOCKED                 |

Removing the competing backend binding before migrating its legitimate writes
would risk breaking accounts, ingestion and payments. Enabling the disabled
owner or an EPUB repair flag would not resolve missing external authority.
Neither action is justified by this review.

The next legal input remains authentic records resolving the disputed cohort
and withdrawal coverage, with exact territory/format/channel/effective-time and
contract scope. Reconciliation must then prove a current independent production
owner denial epoch before positive generation publication or customer sales.
