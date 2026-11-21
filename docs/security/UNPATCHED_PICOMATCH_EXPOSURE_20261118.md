# Cove — picomatch advisory withdrawal and strict dependency verification

**Updated:** November 21, 2026 (UTC)
**Advisory:** [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) / CVE-2026-112366
**Cove release status:** **NO-GO** — independent production legal, commerce, performance, 503 and rollback gates remain open.

## Verified change after the November 18 investigation

GitHub **withdrew** this advisory on **November 18, 2026** (last updated November 19), stating explicitly that the reported behavior is *not a security issue*. The advisory URL remains published for historical reference. It lists no patched version because the advisory was withdrawn, **not** because an active security issue was silently waived.

Before withdrawal, Cove's complete `npm audit --audit-level=high` reported high findings cascading through `picomatch` consumers. The audit had to stay red while the finding was active. After the authoritative withdrawal, the **unchanged complete-install audit** was independently rerun on dependency-remediation draft PR #770 (head `7b98cce85bddbb70636b90d8dfbb2ae6981b8c23`):

- [Security workflow #44261766158](https://github.com/JibrilMohamud/cove/actions/runs/44261766158): `dependency-audit`, `source-checks` and required `supply-chain` all **PASS** on the rerun.
- [Zod compatibility workflow #44261766077](https://github.com/JibrilMohamud/cove/actions/runs/44261766077): previously audit-blocked `secured-v4-runtime` **PASS** on the rerun.
- This is exact-branch evidence. **Main** still has its older dependency tree until the candidate is reviewed and safely promoted. Do not treat the advisory withdrawal as proof that unpatched, separately identified esbuild/serializer/parser vulnerabilities in main are gone.

No `npm audit` suppression, `--omit=dev`, advisory allowlist, package rename, fork pretending to be an upstream fix, status override or reduced severity threshold was used.

## Continuing defense in depth

The existing `scripts/security/check-glob-matcher-runtime-exposure.mjs` inspects the installed lockfile and parses customer-serving `src/`, `app/` and `server/` source; it rejects direct imports, re-exports and dynamic/requires of `picomatch`, `tinyglobby` and `unplugin`. Mutation cases verify that the check fails for introduced imports. This is a **narrow source-level boundary**, not a claim about all indirect runtime imports or all possible glob expressions.

Keep the complete mandatory `npm audit --audit-level=high`, source security, pinned dependencies, secret scanning, TypeScript, domain, rights and browser QA on every release candidate. If another high/critical issue appears, the required `supply-chain` must fail normally. Never downgrade or bypass the protection.

## Independent NO-GO gates

A clean dependency audit on #770 does **not** certify production: legal owner remains disabled; exclusive primary-D1 writer is unproven; LIVE Stripe entitlement/refund/revocation needs owner proof; real storefront 503 elimination and the unchanged strict four-region <800ms / two 100-RPS phases are unpassed; protected, legal/payment-compatible rollback has not been rehearsed. The update changes only draft source documentation; it does not touch production traffic, Worker settings, tokens, D1, rights, entitlements or payments.
