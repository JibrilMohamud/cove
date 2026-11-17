# Cove protected evidence: phase #52 and physical D1 writer #36

Date: 2026-11-17. Approved main at time of live checks:
`bba4632d118bd184d63e57d73aaacef1c89d2777`.

## Protected stage #52: real latency failure, safe rollback success

[Manual run #52](https://github.com/JibrilMohamud/cove/actions/runs/44023389902)
successfully updated the previously parked isolated Workers, exercised 120
rights-positive catalog SSR reads, and independently verified complete and
legal-source-attributed numeric diagnostics. **No deployment failure.**

Evidence archive:
[stage #52 numeric report](https://github.com/JibrilMohamud/cove/actions/runs/44023389902/artifacts/14301867425).
The report contains bounded numeric per-request phases, not raw SQL, offers,
book identifiers, API credentials or customer source data.

- 120/120 authorized response proofs valid and 120/120 fully attributed;
  zero HTTP failures
- 32/32 immediately paired anonymous denials returned HTTP 401
- 13/120 genuine hard <800 ms TTFB violations: 1/60 cold reads and
  12/60 concurrent reads
- Largest 1/4/8/16 concurrency cohort latencies: 1021 / 462 / 1394 / 951 ms
- Failures at 1, 4, 8, 16: 1 / 0 / 2 / 9
- Cold trial maxima: 831 / 736 / 779 ms
- In 16-concurrent cohort, median measured SQL execution ~19.1 ms;
  median measured D1 REST preheader ~349.5 ms;
  median Worker duration ~434.5 ms; median outside-Worker residual ~140.5 ms
- Worst request, 1394 ms at 8-concurrency: SQL 24.5 ms, REST preheader
  378 ms, Worker 485 ms, outside Worker 909 ms
- Successful isolated stage rollback: `PHASE_STAGE_DENY_ONLY_RESTORED=2`,
  independent `postflight` confirmed production unchanged, stage versions
  pinned to independently known deny-only 401 binaries at 100%, zero
  deployed bindings and no public ingress

**Do not** move the latency threshold, average away slow samples, infer a
single network root cause, turn off immediate legal denials, or mark release
certified because authorization passed. REST preheaders and client-to-Worker
residuals are separate measured intervals, not definitive infrastructure fault
assignments. This test is not geographic 4-region or 100-RPS acceptance.

### Isolated experimental transport candidate: Smart Placement

Cloudflare's published [Worker placement guidance](https://developers.cloudflare.com/workers/configuration/placement/)
permits `placement.mode=smart` to reduce Worker-to-upstream roundtrips. The
**only** candidate configuration changed here is
`wrangler.canonical-phase.staging.jsonc`, the separately protected private
reader using existing D1 **Read** scoped REST credentials. It is configured
to prefer backend placement rather than always running at the incoming edge.
No source/query/offer/authorizer/result/status/caching semantics change.
Production read service, legal owner, Worker pins, bindings and routes
remain unchanged.

Smart Placement may require **up to 15 minutes** and sufficient real
traffic to determine placement. A protected cold run immediately after
deploy could therefore show no effect; do not confuse unlearned placement
with demonstrated lack of benefit, and do not prewarm the three required
cold trials to manufacture a pass. Only an explicit, serialized, protected
A/B measurement after the feature has settled should establish improvement.
If worse or inconclusive, revert this staging-only candidate in source
without changing any release hard gates.

Immediate next performance gates remain **every cold and warm TTFB <800 ms**
at 1/4/8/16/32, four-region ORD/LAX/IAD/DFW repeatability, two independent
20-second 100-RPS phases (2,000 valid responses each), p95 <600, p99 <750,
max <800, zero drops, and customer-facing SSR 503 elimination.

## Protected physical writer #36: complete audit, genuine NO-GO

[Manual run #36](https://github.com/JibrilMohamud/cove/actions/runs/44023744592)
successfully read and compared all 460 Worker revisions, including 460
Worker-binding records plus two inventory calls. Total 464 read-only API calls,
zero rate-limit errors. Actual result `certified:false` and these four
independently failing conditions:

1. `production_owner_disabled`: legal owner still `COVE_RIGHTS_OWNER_ENABLED=0`
2. `nonowner_primary_d1_binding`: `cove-persistence-backend` retains
   direct native binding to the actual production D1 (two total Workers
   hold the primary D1, including the disabled legal owner)
3. `active_account_token_can_mutate_primary_or_owner`: two active
   mutation-capable account tokens:
   `COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN` and `Cove GitHub Deployments`
4. `user_token_inventory_unverified`: current user-scoped token inventory
   could not be positively certified as complete and nonprivileged

The protected run has the three required secrets present. The fourth finding
**does not imply those secrets were missing**: the current implementation
collapses endpoint access, pagination, metadata, and unsafe active user tokens
into one boolean. The new allowlisted reason code will distinguish these
without revealing private token inventories. A user-owned Cloudflare token
only sees its issuing user's tokens. The inventory evaluator now **explicitly
fails** `all_user_token_principals_unverified` independently of whether
the current user token inventory passes. Full account-member/principal
scope must be positively established using independent, protected evidence
before code may ever set `userPrincipalCoverageVerified=true`; there is
no environment-variable override or manual bypass in this change.

**Never** revoke `Cove GitHub Deployments`, remove the persistence Worker
binding, or activate the legal owner without validating replacement consumers,
protected rollback and authorized legal/paid settlement. Track privileged
token retirement under [issue #751](https://github.com/JibrilMohamud/cove/issues/751).
Production remains NO-GO for legal ownership, complete Stripe LIVE
settlement-to-refund-revocation, full catalog 503s and geographic performance.

## Change safety

The experiment and revised user token audit only affect stage-only Wrangler
configuration and credential-free diagnostic source. No production Worker
versions, customer domains/routing, primary D1 rows, active legal ownership,
user entitlements, secret values or Stripe operations were changed.
