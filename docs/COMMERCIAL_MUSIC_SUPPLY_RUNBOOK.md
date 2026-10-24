# Commercial music supply: physically isolated QA foundation

**2026-10-23 state:** Staged schema exists in D1
`cove-music-supply-qa-20261023` (UUID
`fe9a9dd2-64b8-451c-a356-9ec71d9ee211`) and in private R2 bucket
`cove-music-supply-qa-20261023`. These are NOT customer resources or
ingestion results. No additional rights-cleared recording has been produced
by this deployment.

## Contract-scale licensing, not per-track listening

The source/operator uploads an immutable evidence JSON with five rights
layers: composition, arrangement, lyrics if applicable, performer,
original master; exact licensor and streaming/territory grant. The contract
registers as **pending**. A distinct reviewer credential, reviewing the
actual signed legal instrument out-of-band, must activate it. Neither a
Wikimedia category label nor a public-domain composition can automatically
establish sound-recording rights.

Only a separately authenticated ingest role may register individually
identifiable master manifests covered by the **active** reviewed contract.
Records remain quarantined. The actual original master is streamed
to private R2 with an enforced content SHA-256 and exact byte size.
An **independent QA credential** must attest to fully decoded audio and
measured loudness, peaks, clipping and silence. Each approval creates
a durable, monotonic, replayable private outbox entry. Contract revocation
creates an explicit high-priority revocation event; export consumers
MUST retract all canonical grants for that contract.

**Critical:** `quality_passed` is only preparation for an authoritative
canonical rights publication, *not* permission for customers to play it.
The worker has no primary production D1 binding, no customer storefront
route, no public URL, no scheduled trigger, and no license key by default.

## Procurement and catalog targets

Start with 1,000 distinct verified masters and evidence-backed streaming
rights, then expand toward 5,000+. Prefer direct original artists,
commercial-license supplier catalogs with machine-readable coverage,
and individually verifiable commercially reusable CC0/CC BY/CC BY-SA
recordings. Reject NC, uncertain arrangements, unreliable performer
claims, unclear EU-only phonogram rights, untrusted recordings and
catalog manifests with duplicates. Track actual unique master SHA-256,
work/recording distinction, market and duration by acoustic tier.
These are unfulfilled supply targets, not results or implied licenses.

## Release work still required

1. Sign or validate legal supplier source agreements and initialize
   contract evidence under the independent reviewer procedure.
2. Provision scoped, independently generated operator/reviewer/ingest/QA
   secrets in the isolated QA deployment (never paste keys in chat).
3. Run genuine supplier manifests, original bytes, full-file QA and rights
   withdrawal through the staging Worker, including malicious-input tests.
4. Build an authoritative canonical publication consumer with fresh legal
   revocation/territorial enforcement; use an independent precomputed
   music playlist read model, not per-reader primary D1 scans. The outbox
   is deliberately not connected to Cove's canonical database yet.
5. Validate acoustic selection against blinded listener evaluations and
   end-to-end customer audio, checkout, rights, concurrency and geography.
   Test background OFF/ON/OFF: **two 12,000/12,000 100-RPS runs**, zero
   drop, p95 <600ms, p99 <750ms, max <800ms, 1/4/8/16/32 burst
   maxima <800ms and cold/headroom/mobile LCP parity. Revert on any
   regression.
6. Only after successful verification enable staged feed processing and
   separately authorize bounded production ingestion, without changing
   customer production routing or storefront certification flags.
