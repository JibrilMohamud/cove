# Cove production diagnostic Worker: uploaded version 452, ZERO traffic

**November 15, 2026 — audited source, read-only preflight, no customer rollout**

## Proven immutable candidate

[GitHub workflow run #43776699810](https://github.com/JibrilMohamud/cove/actions/runs/43776699810)
passed:
- Reviewed backend source pinned to main merge commit `d2672335728d28ebd387d1b115e23db2e1f36d7d` (#705).
- The `wrangler.backend.deploy.toml` used for upload was generated **from the existing production deployment workflow's heredoc** rather than handwritten clone configuration.
- Read-only Cloudflare preflight required active production version **451**, ID `401f2af2-6e69-4611-8110-1d127af6eecf`, exactly 100% of traffic, deployment `86d49417-d6e5-40cb-a7e4-8245fbf26a09`.
- `wrangler versions upload --keep-vars` produced one archived **version 452**, ID `3fbbfec3-22c7-4eb4-b689-ea38f629cabe`, tagged `cove-diag-43776699810`.
- An independent subsequent Cloudflare API read confirmed **all named bindings and nonsecret settings match** active version 451, including primary D1, legal owner, analytics, R2, KV, rate limiter and Worker runtime date `2026-09-01`.
- The candidate is **NOT in the active deployment**. Version 451 remains **100%**; version 452 serves **0%** customer traffic.
- An unconditional last CI step independently rechecked the unchanged production deployment, even in the event of earlier failure.

The upload did **not** apply migrations, alter D1/R2, activate legal authority, change Stripe money/entitlements, change Vercel routing, or modify production Worker deployment percentages.

## Actual live 503s after the Vercel diagnostic merge

On the `www.covereads.com` production alias (the new Vercel deployment from #705), five low-rate GET probes were run at 23:52–23:53 UTC:

| Route | Actual response |
| --- | --- |
| `/api/fore/catalog` | **503** |
| `/api/fore/storefront/bootstrap` | **503** |
| `/api/fore/storefront/context` | 200 |
| `/api/fore/taxonomy` | 200 |
| `/api/fore/health/live` | 200 |

Production Vercel runtime warning logs at 23:52:49 classified catalog as `worker-api post-context unknown catalog-rights`; bootstrap at 23:53:15 as `worker-api pre-context unknown handler-exception`. The `unknown` stage is expected: Worker 451 does not yet emit numeric stage markers. These are **not** proof of a single D1 root cause, and the 503 incident remains active.

## Deployment safety gap discovered

Cloudflare's documented public `Cloudflare-Workers-Version-Overrides` header can select a Worker version included in a deployment even at 0% default traffic. Cove's Vercel `gatewayHeaders` previously forwarded it unfiltered. Draft [PR #713](https://github.com/JibrilMohamud/cove/pull/713) strips both this header and the client-controlled `Cloudflare-Workers-Version-Key` before the trusted Vercel-to-Cloudflare gateway. **Do not include candidate 452 in a dual-version deployment until the gateway fix has passed CI and reached production.**

## Open next gates

A safe diagnostic rollout should be single-purpose and short-lived, with exact prior-version pin, a limited traffic percentage, fixed-category failure measurements from independent Analytics Engine and Vercel logs, guaranteed version-451 rollback with separate verification, and a hard stop on risk to paid/legal access. An uploaded-but-inactive version is not itself proof of 503 elimination, real production rollback, paid rights, four-region latency or 100RPS acceptance.

Cove remains NOT production-certified.
