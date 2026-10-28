# Refund, publication, offline access and owned-ingress release work

Production release remains blocked. This record separates actual production
fixes, private command implementation, and certification evidence.

## Production runtime handshake — deployed and passed

[PR 423](https://github.com/JibrilMohamud/cove/pull/423) merged at
`c706eae6dc9fbc1951451f086b64739bb4720790` after 20 successful checks and
seven explicitly skipped jobs. Backend deployment
[40788098744](https://github.com/JibrilMohamud/cove/actions/runs/40788098744)
passed the actual fresh-nonce challenge from the backend's existing private
credential and production DO binding. Backend version:
`107ba3cc-17c8-4b32-8086-7de69233c3e2`.

The named RPC entrypoint has no HTTP diagnostic method and no legal command.
The expiring verifier was deleted and its absence checked. Production owner
enablement stayed `0`; the namespace is
`83d7eadf3957436389a7b072120a9829`, with canonical primary
`4bd657ac-8789-403e-a28c-93aba8d0a989`.

## Functional changes under integration

- Refund requests resume a persisted pending intent after owner/provider
  outage using the original Stripe idempotency key or exact provider object.
  Unknown provider outcomes keep their tender reservation. A conditional
  insert prevents two different keys from reserving the same refund balance.
- Refund tender restoration, balanced ledger, order totals, fulfillment,
  promotion changes and success marker commit in one D1 batch. Interrupted
  royalty calculations similarly commit their marker, allocations and balanced
  ledger together. A retry repairs post-core projections without asking the
  payment provider to refund again.
- Enrolled refund/dispute callers use the typed private owner order-revocation
  command. A durable exact-order tombstone precedes owner-held D1
  reconciliation; replay repairs an interrupted primary write. A later valid
  purchase uses a fresh order and entitlement without reviving the old order.
- Audio offline issuance reloads the exact active purchase and device and
  obtains a final owner decision before signing. The receipt, response and
  stored row share the same expiry, bounded by the purchase. Online verification
  rejects malformed dates. Existing policy remains seven days for EPUB and
  thirty days for audio, subject to shorter entitlement expiry; disconnected
  receipts cannot receive immediate remote revocation.
- Initial scheduled publication no longer mistakes the current scheduled
  version for an already completed activation or retires its own grants.
  Retained grants survive a version change. A typed preorder command validates
  immutable snapshot bytes, publisher compliance and the due window before a
  durable hold and canonical writes. Positive publication requires fresh legal
  and storefront verification. Enrollment is still restricted to private QA.
- Anonymous production bootstrap uses fresh primary metadata and starts the
  rights query concurrently with metadata after rate-limit admission. Rejected
  requests cannot use speculation to issue the expensive query. Currency,
  regional rights and saved-preference behavior remain covered by tests.

## Canonical inventory

The current scanner finds **460** source candidates across **26** files:
**435 owner commands still required**, **24 non-authorizing**, **one isolated
fixture**, and **zero certified production-owner-guarded sites**. This replaces
458/433 after refund extraction added two static SQL sites. It is not a claim
that two additional security defects were discovered. The source scanner and
the production release denial remain active, including every new SQL literal.

## Verification

Local real-handler tests exercise 15 refund batch interruption boundaries,
13 royalty transaction boundaries, lost commit responses, concurrent requests,
repurchase, scoped revocation, scheduled activation, preorder publication,
withdrawal races, original audio signing, expiry and device changes. These
tests use SQLite plus the actual bundled application handlers; they are not
a deployed customer certificate.

The deployed Stripe TEST campaign additionally checks original EPUB/audio
bytes, renewal token rotation, prior-token rejection, exact signed/stored expiry,
owner outage and refund. Results for the final merged revision must be
recorded from the workflow before claiming success.

The protected owned-domain campaign tests actual native SSR through
`ssr-canary.covereads.com`: independently rotated cold bursts at 1/4/8/16/32,
warm bursts at the same levels, and two complete open-loop 100-RPS phases
of 2,000 responses over 20 seconds. Every failed sample is retained; max
TTFB must be below 800 ms, sustained p95 below 600 ms, p99 below 750 ms,
with no drops or invalid responses. Only its ephemeral rate-limit namespace
permits the authorized campaign; production's 180/minute policy is unchanged.
The canary is detached and its two temporary Workers deleted after testing.
This campaign does not certify ORD/LAX/IAD/DFW repeatability.

Before these functional changes were deployed, a read-only probe from the
Work execution environment against `https://www.covereads.com` at
2026-10-28 23:26:56 UTC completed 20 valid HTML responses with 24 cards each,
but 16 exceeded 800 ms: p75 1,259 ms and p95 2,038 ms. This is one egress
observation, not field LCP, an independent cold deployment, or a provider-only
latency diagnosis.

## Release decision

The production owner remains disabled. Positive production writer closure,
production customer certification, all strict hosted/geographic results and
the protected Cloudflare-to-Vercel rollback rehearsal are still required.
No public frontend route or DNS cutover is authorized by this record.
