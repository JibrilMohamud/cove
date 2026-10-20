# Regional EPUB metadata backfill — operator rollout (release-gated)

## Current status
**DO NOT RUN AGAINST PRODUCTION YET.** This runbook documents an operator-only
coordinator. The repair endpoint is disabled by default. Independent
commercial-readiness issue #238 and draft integration PR #241 remain gated on
shared D1 capacity, rights, signed-in/offline browser journeys and rollback.

## Verified evidence

- Live readonly D1 sample: 3,515 AU and 97 CA source-completed eligible
  records lack a normalized EPUB asset pointer. The counting query scanned
  39,492 rows with approximately 871 ms of D1 SQL service. Do not repeat
  bulk aggregations on a customer-critical request.
- Real readonly R2/rights inspection: three AU EPUB ZIP/OPF files passed,
  with valid private object SHA metadata and AU-only live grant checks:
  https://github.com/JibrilMohamud/cove/actions/runs/39407854055
- Synthetic bounded R2+D1 repair passed in isolated Cloudflare stage:
  https://github.com/JibrilMohamud/cove/actions/runs/39403569258
- New repair code requires active, unexpired, correct-source territorial
  grants **both on selection and at each database mutation**, not merely
  Gutenberg source-level approval. Unit fixtures use approved source
  evidence under production-equivalent trigger constraints.

## Preconditions for a production canary

1. Confirm an immutable combined release SHA, backend auth token rotation,
   current D1/R2 bindings, exact deployed code and enabled feature flag.
2. Prove representative real AU/CA books can open/read offline through the
   signed-in reader, including market denial and live revocation tests.
3. Obtain mixed-load benchmark showing at least 1/4/8/16/32 independent
   concurrent TTFB bounds, 100-RPS sustained rights/commerce/reader load,
   mobile LCP, and zero D1 queue overload while a backfill is active.
4. Approve specific pilot capacity by a release owner and retain rollback
   from a D1 backup/snapshot. Do not modify or grant territorial rights.
5. Restrict operator secrets to a short-lived, audited job and keep the
   journal artifact in a private retention-controlled location.

## Operator script (not yet authorized)

Default: `node scripts/operate-regional-epub-backfill.mjs` makes zero network
calls. It cannot silently mutate any environment.

After release owner approval, a protected runner can execute:

```sh
export COVE_REPAIR_ORIGIN="https://<verified-backend>.workers.dev"
export COVE_REPAIR_TOKEN="<short-lived-secret>"
export COVE_REPAIR_CONFIRM="REPAIR_VERIFIED_REGIONAL_EPUBS"
export COVE_REPAIR_BATCH_SIZE="2"
export COVE_REPAIR_MAX_BATCHES="1"
export COVE_REPAIR_DELAY_MS="15000"
export COVE_REPAIR_AFTER=""
node scripts/operate-regional-epub-backfill.mjs --execute
```

The script hard-limits a batch to 1–4 rows and a run to 1–20 batches,
requires 10–60 seconds between requests, and defaults to just 2 records
in one batch. It uses a 30-second request timeout and never retries a 401,
403, 503, redirect, malformed response, stalled cursor or transport failure.

Each request records a `started` receipt **before** the mutation and a
`complete` or `error` entry afterward in the private JSONL journal under
`out/regional-repair/<UUID>.jsonl`. Never retain bearer tokens in receipts
or shell logs. Interrupted runs may have committed a batch before the
network failed; reconcile the private D1 assets/R2 object and journal
before resuming from a previously confirmed cursor. Run IDs never imply
exactly-once backend execution; the repair is intentionally idempotent.

## Mandatory rollback and audit

- On latency, D1 overload, stalled leases, rights mismatch, non-200 or reader
  regression, **disable the repair endpoint** and stop the operator.
- Do not revoke customer rights or delete genuine EPUB objects as rollback.
- Reconcile only asset pointers created by the verified canary if necessary,
  preserving original source records and access proofs.
- Record immutable code SHA, live active grant status, protected object SHA,
  batch cursor, records created, and post-repair real reader acceptance.
- Expand beyond the first pilot only with unchanged live grants,
  demonstrable primary-D1 headroom and explicit release approval.

The script improves operational safety but does not constitute physical
background/rights D1 isolation or commercial-grade load certification.
