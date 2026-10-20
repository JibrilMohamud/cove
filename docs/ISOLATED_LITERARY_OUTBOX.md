# Cove literary preparation — bounded cross-D1 outbox (DRAFT, OFF)

Cove now has physically separated private EPUB preparation and an
authoritative, nonpublic receipt import. This milestone closes the missing
**catalog intent -> independent preparation** handoff. It is still not
commercial-release authorization.

## Boundaries and load

- The primary D1 remains authoritative for products, source hashes,
  territorial grants and denies. An explicit operator prioritizes one
  product/edition at a time through `seedLiteraryPreparationHandoff`.
  The primary `literary_prepare_outbox` intent is inserted **with
  current live source and territorial grants checked in SQL**. No
  full catalog scan, visitor-triggered enqueue or unbounded fanout.
- A separate `literary-handoff` role with
  `FORE_CONTENT_PROCESSOR_ENABLED=1`,
  `FORE_CONTENT_PREPARE_ENABLED=1`, and
  `FORE_CONTENT_HANDOFF_ENABLED=1` claims at most **one primary outbox
  intent per cron tick**, with a 2-minute lease and four-attempt cap.
- It passes the exact source ID and content SHA snapshot to the physically
  separate content D1. The dedicated enqueue rechecks authoritative
  primary grants and content hash immediately, then commits the stable
  content-addressed `literary_prepare_jobs` ID.
- Only after the independent enqueue returns the **identical expected
  id** does the primary outbox become `delivered` via the original
  claim's lease token. On unavailable secondary D1, an old lease or an
  interrupted ACK, retry uses the same idempotent job ID. False claims
  are never silently treated as delivered.
- Revoked/explicitly denied rights and changed source fingerprints cancel
  stale intents. Final isolated preparation and nonpublic evidence import
  independently recheck rights. Prepared evidence is not an entitlement.
- Production flags default OFF, with no auto-seeding. The standalone
  `literary-prepare` role remains the independent CPU/R2 executor and
  cannot be used to dispatch outbox claims. No new site endpoint is
  opened. There are **no customer-facing literary_profiles writes** in
  this lane.

## Rollout and rollback (still release-gated)

1. Apply `0004_literary_handoff_outbox_primary.sql` only on a separately
   approved **primary staging fixture** (not production). Apply
   `0001` and `0002` on its separately provisioned CONTENT_DB.
2. Prove stable idempotence with claim lease expiry, vanished cross-DB ACK,
   duplicate delivery and retried dispatch, as well as rights revocation
   and stale content source hash.
3. Use only bounded operator-selected books and at most one dispatcher
   claim/tick; measure primary read/write amplification under mixed load.
4. Coordinate with the legacy literary scheduler. Do not run two separate
   production ingestion writers with conflicting job ownership or rely on
   a cosmetic Worker split as D1 isolation.
5. On primary D1 saturation, immediately disable handoff and preparation
   flags, leaving independently queued work and replayable outbox receipts
   intact. Reconcile status before resuming; don't delete grant history
   or re-authorize stale sources.
6. Before promotion, validate signed-in customer storefront, chapter
   reading, checkout, audio and territorial revocation under cold,
   1/4/8/16/32 bursts and 100-RPS sustained mixed traffic with
   background work active. No customer-access or LCP regression permitted.

## Limitations

Handoff remains **two bounded writes to primary D1 per delivered book**,
plus reads. This is not literal zero-primary-write processing; the
preparation claims, AI budget and preparation artifacts are physically
isolated. A future event feed/CDC can amortize primary handoff overhead
when justified, but the primary catalog/rights service must retain
authoritative source and revocation checks.

The product-facing `literary_profiles` and `literary_profile_sections`
publisher is unchanged. No commercial launch, background activation,
music licensing approval or production-routing change follows from
this isolated lane passing CI alone.
