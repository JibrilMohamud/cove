# Cove production primary-D1 physical writer audit

**November 15, 2026 — READ ONLY. Release is BLOCKED.**

## Actual live Cloudflare inventory

The account API returned 458 Worker scripts. Script settings for **every one of the
458** were read independently, with **zero settings errors**. There were 427
historical cove-arch/cove-pub scripts and 31 other Cove scripts. No historical
architecture/publication script had a production-primary-D1 binding.

The only direct Worker bindings to production primary D1
(4bd657ac-8789-403e-a28c-93aba8d0a989) were:

- cove-legal-authority-production: PRIMARY_DB
- cove-persistence-backend: DB

The production owner still has COVE_RIGHTS_OWNER_ENABLED=0. A binding does not
prove actual executed writes, but a D1 binding is a write-capable authority
unless physically removed or fenced by other independently enforceable controls.

All 6 visible account-scoped tokens were inventoried without obtaining or
printing their secret values. The active "Cove GitHub Deployments" account token
still grants D1 Write, Workers Admin, Workers Scripts Write and Account API Tokens
Write at the account resource scope. "Cove canonical primary READ ONLY service"
and "Cove Staging Data Plane Readonly" have D1 Read and no D1 Write.

Cloudflare returned HTTP 403 to the separate user-scoped token inventory. This
MUST count as unverified scope, never evidence of zero user-level writers.
No active tokens were revoked or rotated. No database, account configuration,
Worker route, production flag, payment or customer record was changed.

## New fail-closed audit utility

scripts/release/certify-exclusive-primary-d1.mjs has an offline self-test and a
live audit. It enumerates every Worker binding, checks the owner binding and
owner-enabled switch, rejects all competing production-D1 Worker bindings,
rejects account tokens with D1 Write / Workers Admin / Account API Tokens Write,
and requires successful verification of user-level token inventory. Missing
permissions, missing scripts, partial results, or failed requests BLOCK.

Use the protected, manual cove-exclusive-primary-d1-writer-audit workflow
once the two **independent read-only** audit credentials and protected environment
exist: COVE_CF_PRODUCTION_AUDIT_READ_TOKEN for account/Worker inventory, and
COVE_CF_USER_TOKENS_AUDIT_READ_TOKEN for user-scoped token inventory. The
account-scoped token cannot be assumed to read user-scoped token permissions;
the observed 403 is a hard release blocker. Never print or paste either token. Do not turn this
into an automatic destructive token-rotation or Worker-binding removal job.

This certifies only *physical Cloudflare owner exclusivity*, not source-level
canonical writer correctness. The existing 33 source SQL-writer sites in
src/features/fore/api.server.ts remain reviewed as owner-command-required.
The legal authorizer, commerce and refund paths need separate certification.

## Why not remove the persistence binding immediately?

Production customer GETs still depend on cove-persistence-backend, and
the production legal owner remains disabled. Removing its only primary DB
binding now would cause additional 503s or an outage, not a safe owner cutover.

The safe order is: complete canonical owner-only mutation commands; verify
exact catalog parity and owner-verified positive publication; certify live
withdrawal and sustained capacity; replace deployment token with least-privilege
credentials; remove competing production D1 write access with audited fallback;
prove a protected rollback; and only then mark writer exclusivity passed.

## Separate performance experiment (not an acceptance result)

A local synthetic 82,249-row catalog/authority SQLite fixture with indexed
source-fence lookups still took 555, 541, and 531 ms for a single SQL statement
that re-scanned the full allowed population to compute exact counts, all
facets and page IDs. The numbers are not hosted Cloudflare TTFB and are not
representative of production data correctness. The naive move of this exact
scan to owner SQLite was therefore *rejected* as a 100-RPS hot path.

An owner-transactional, incrementally maintained authorized catalog index,
precomputed common facets and indexed page reads are a better candidate.
A mandatory future proof must cover every SearchInput filter, disjunctive facet,
stable page and count semantics, positive and negative legal transitions,
signed presentation/current-offer agreement, and source clock/expiry behavior.
The unoptimized exploratory source was NOT deployed or merged.

## Independent release gates still closed

Real customer 503 elimination, all-book catalog/API exactness, production
canonical writer exclusivity, legal owner activation, Stripe LIVE
settlement-to-revocation, four-colo cold/warm strict <800ms maximum and
2x2,000-response 100-RPS acceptance, and a protected rollback are all BLOCKED.
This audit cannot be used to claim that the release is already certified.
