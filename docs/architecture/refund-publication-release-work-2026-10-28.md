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

## Functional changes merged for deployed certification

[PR 424](https://github.com/JibrilMohamud/cove/pull/424) merged at
`272e6e0e7aec1bf9b739d1d8fd92ae2b728e4235`. Functional source, security,
publishing, owner, six browser-profile and screen-reader checks passed.
Failing release capacity results remain blocking; merging these repairs
does not authorize a frontend traffic change.

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
  and storefront verification. A completed owner publication can retain its
  exact valid price and legal grant; an uncommitted hold, ordinary retail
  withdrawal or terminal legal withdrawal cannot use that exception.
  Enrollment is still restricted to private QA.
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

The deployed Stripe TEST campaign on merge `272e6e0e`,
[run 40790471374](https://github.com/JibrilMohamud/cove/actions/runs/40790471374),
passed original EPUB/audio bytes, renewal token rotation, prior-token rejection,
exact signed/stored expiry, owner outage and refund. The genuine two-account
Supabase browser journey,
[run 40790471325](https://github.com/JibrilMohamud/cove/actions/runs/40790471325),
passed login, signed fulfillment, original EPUB/audio, outsider denial and the
actual refund endpoint. Cleanup removed the temporary isolated refund role,
destroyed the offline signing key and disabled QA ingress. These separate
isolated QA campaigns do not certify production owner authorization.

The production backend deployment,
[run 40790471333](https://github.com/JibrilMohamud/cove/actions/runs/40790471333),
passed again at version `883337b7-9683-4ecd-87bc-bd939c586dc7`, including the
fresh-nonce disabled-owner handshake and deletion of its verifier.

The protected owned-domain campaign tests actual native SSR through
`ssr-canary.covereads.com`: independently rotated cold bursts at 1/4/8/16/32,
warm bursts at the same levels, and two complete open-loop 100-RPS phases
of 2,000 responses over 20 seconds. Every failed sample is retained; max
TTFB must be below 800 ms, sustained p95 below 600 ms, p99 below 750 ms,
with no drops or invalid responses. Only its ephemeral rate-limit namespace
permits the authorized campaign; production's 180/minute policy is unchanged.
The canary is detached and its two temporary Workers deleted after testing.
This campaign does not certify ORD/LAX/IAD/DFW repeatability.

The first real owned-ingress campaign on source `9a191023`,
[run 40788876111](https://github.com/JibrilMohamud/cove/actions/runs/40788876111),
**failed**. Its initial 20-request probe passed with p95 173 ms, but independent
cold maxima were 492/576/819/1,253/1,598 ms at 1/4/8/16/32 concurrency.
Warm 32-concurrent maximum was 914 ms. The two 100-RPS phases returned
894/2,000 and 958/2,000 valid responses, with 1,106 and 1,042 dropped arrivals;
p95 was 3,971/3,595 ms and max 5,291/3,921 ms. All failed samples remain in
artifact `12860488706`. These requests reached STL, which is not a certificate
for the required four regions. Mobile lab LCP p75 was 4,020 ms. Cleanup passed.

Catalog calls in that run had medians of 1,475/1,276 ms while their SQL
execution medians were 11.0/10.7 ms; context calls had medians of
1,865/2,174 ms. This supports primary-service queueing/latency as a material
bottleneck; it does not isolate every provider or background-workload cause.

An acceptance scheduling defect also canceled a required main campaign:
GitHub's default shared concurrency group retains only one pending run.
Both source verification workflows now have independent PR groups; only
their live deployment jobs share the exclusive queued group. Both live campaigns
use `queue: max` with cancellation disabled, so independent real-primary load
tests remain serial without replacing pending runs. PRs run owned-ingress
source checks; the live owned campaign runs on main or manual dispatch.
This scheduling change does not make failed performance evidence pass.

Before these functional changes were deployed, a read-only probe from the
Work execution environment against `https://www.covereads.com` at
2026-10-28 23:26:56 UTC completed 20 valid HTML responses with 24 cards each,
but 16 exceeded 800 ms: p75 1,259 ms and p95 2,038 ms. This is one egress
observation, not field LCP, an independent cold deployment, or a provider-only
latency diagnosis.

On merge `272e6e0e`, native staging
[run 40790471385](https://github.com/JibrilMohamud/cove/actions/runs/40790471385)
failed: cold-trial p95 was 1,149/245/173 ms, with four responses at least
800 ms in the first trial. Concurrency 8/16 maxima were 1,004/1,107 ms.
Fresh-browser staging LCP p75 passed at desktop 816 ms and mobile 1,684 ms,
with no failed script or stylesheet requests. This does not override the
cold/concurrent failures or certify geography and field vitals.

The default Vercel production-host probe on the same merged source,
[run 40790471392](https://github.com/JibrilMohamud/cove/actions/runs/40790471392),
failed with 18 slow responses and p95 1,067 ms. Separately, a fresh probe of
`https://www.covereads.com` at 2026-10-29 00:02:22 UTC returned 20 valid
24-card HTML responses, but 12 were slow; p75 was 1,047 ms and p95 3,326 ms.
Neither probe is an independently cold deployment or a field-vitals result.

Read-only control-plane inspection after these campaigns confirmed owner
switch `0`, the exact production primary and owner bindings, unproxied Vercel
CNAMEs for apex/www, no attached owned canary, and no remaining temporary
owned-auth gateway/assets Workers. The stable isolated customer-QA Worker
remains present with its ingress and temporary signing capability disabled.

## Anonymous primary context follow-up

The cookie-free bootstrap now negotiates its supported locale, follows the
bounded translation fallback chain, selects payment methods, and reads the
market/homepage presentation in one fresh primary statement. It removes the
dependent payment/translation D1 batch; the separate live territorial retail
rights statement remains mandatory. Session-bearing requests continue through
the preference-aware resolver. Native anonymous admission now completes before
any primary query starts.

Executable checks compare the new snapshot with the original resolver across
49 country/language pairs, unknown-market fallback, cyclic translation fallback,
live translation/payment edits and absent active locales. Existing tests retain
the exact rights-filtered shelf, cookie preferences, supported currencies,
rate-limit denial and concurrent context/shelf ordering. Typechecking, lint
baseline and backend build pass. The unchanged `upsertMarket` writer was
reviewed byte-for-byte; only its source identity/line changed in the inventory.
All 435 required production owner migrations remain open. Hosted performance
must be measured on the deployed follow-up revision; local parity is not a
capacity certificate.

## Acceptance queue verified on main

[PR 425](https://github.com/JibrilMohamud/cove/pull/425) merged at
`4ad4df3f2b13afc90f16299f8fa8b216be59707d` after six successful browser
profiles, source, security and screen-reader checks. Owned-ingress
[run 40792375327](https://github.com/JibrilMohamud/cove/actions/runs/40792375327)
completed with its original failures retained. Its initial 20-request check
passed (p95 509 ms). Independently cold 1/4/8/16/32 maxima were
861/905/1,189/1,135/1,491 ms; warm 32 reached 1,105 ms. Both 100-RPS phases
failed: 971/2,000 and 844/2,000 valid responses, with 1,029/1,156 dropped
arrivals and p95 3,544/4,241 ms. Artifact `12862995359` preserves every sample.
Observed ORD/YYZ ingress is not the required four-region certificate.
Mobile lab LCP p75 was 1,532 ms; desktop failed its full gate because one
navigation reached 6,477 ms TTFB despite p75 LCP of 760 ms.

The native main campaign waited pending while the owned job held the shared
lock, then started after its cleanup; neither pending run was replaced.
Control-plane reads confirmed the canary detached, apex/www still on Vercel,
the exact production primary/owner binding and owner enablement `0`.
These are baseline results before the local anonymous-context follow-up.

## Release decision (unchanged)

The production owner remains disabled. Positive production writer closure,
production customer certification, all strict hosted/geographic results and
the protected Cloudflare-to-Vercel rollback rehearsal are still required.
No public frontend route or DNS cutover is authorized by this record.
