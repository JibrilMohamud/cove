# Physically isolated literary inference and authoritative publication

**Deployment state: opt-in implementation, NOT a production cutover.**

## Authority/data-plane ownership

- **Canonical primary D1** holds products/source SHA, current allow and overriding deny
  grants, customer profiles, final authoritative state and outbox intents. No
  secondary database stores a rights grant or customer entitlement.
- **Isolated CONTENT_DB** holds a separate daily quota, `literary_prepare_jobs`,
  `literary_inference_jobs`, leases, attempts, response receipts, retries, and
  worker-settlement receipts. Inference job keys hash the full prepared job ID,
  active profile fingerprint, policy and model.
- **Private R2** holds byte-verified EPUBs, selected text evidence, and hashed
  literary profile results. The full object bytes are SHA-256 verified before
  inference and publication; matching HEAD metadata alone is not trusted.
- **Final publication** is one bounded, indexed, canonical UPDATE of an existing
  **provisional** `literary_profiles` row: the exact expected policy/fingerprint/
  revision must match, and the SQL mutation itself checks that source SHA still
  matches and the currently effective source allow has no overriding territory
  deny. A retry cannot bump a published profile revision twice.
- The existing legacy literary job scheduler and public profile routes are
  unchanged; only the entirely separate `literary-infer` worker role invokes
  this new processing logic.

## Execution and safety gates

1. Use two **different staging D1 databases**. Install content migrations
   0001, 0002, 0005, 0006 and 0007 only into CONTENT_DB; install the existing
   primary canonical and outbox schema only into a separate approved primary.
2. Keep the Worker and existing primary processing flags unchanged. The
   new role requires `FORE_CONTENT_PROCESSOR_ENABLED=1`,
   `FORE_CONTENT_PREPARE_ENABLED=1`,
   `FORE_CONTENT_INFERENCE_ENABLED=1`, and
   `FORE_CONTENT_BUDGET_MODE=isolated`; all default to OFF.
   The independent budget still requires the operator's explicit primary
   `literary_budget_domain=isolated` fence and a seeded active UTC day
   with original prior spend. Inconsistent or contaminated bindings fail closed.
3. On a worker tick, select at most one completed isolated EPUB job, read
   one indexed provisional primary profile, and create a content-addressed
   inference lease in the secondary. Each inference reserves quota only in
   independently fenced CONTENT_DB, uses a bounded prompt/output, saves a
   private R2 hash-verifiable result and ACKs the secondary job with the
   original lease token. Retries reuse an existing identical verified R2
   result rather than duplicate inference.
4. The publisher is not exposed as an HTTP route or cron. A separately
   authorized, operator-invoked canonical `publishIsolatedLiteraryInference`
   call additionally requires `FORE_LITERARY_INFERENCE_PUBLISH_ENABLED=1`
   (OFF by default). The prepared result and inferred result are both
   fully byte-verified and their evidence IDs validated before a single
   live-rights/fingerprint/revision guarded primary-D1 mutation.
5. Do not activate this candidate on production until approved operator
   staging migrations, end-to-end source/revocation tests, OFF/ON/OFF
   100-RPS under active mixed ingestion and checkout, 1/4/8/16/32 maxima
   below 800 ms, mobile p75 LCP, and protected playback/commerce
   authentication all pass in multiple Cloudflare regions.

## Recovery and known limits

- Existing queued secondary claims survive Worker termination and resume
  after expired leases, with three attempts and bounded backoff. Primary
  canonical publication can be retried without rewriting secondary jobs;
  rights revocations and source changes make stale receipts permanently
  ineligible for publication.
- The old primary writer is **not** automatically retired. Cutover requires
  an explicit freeze/drain of its `literary_profile_jobs` claims and
  reconciliation of active book fingerprints, plus an agreed rollback.
- Primary intent/source/rights reads and the single final authority write
  remain deliberately primary. They must be benchmarked as short indexed
  operations, not eliminated by copying legal authority to an eventual
  cache. These tests prove code-level isolation and correctness, **not**
  currently active production isolation, rights provenance of all books, or
  geographic performance certification.
