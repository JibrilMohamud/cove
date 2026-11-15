# Isolated Cloudflare Worker rollback mechanism: staged proof

**November 15, 2026. Research-only. NOT production rollback certification.**

## Environment and deliberate boundaries

The [draft PR #711](https://github.com/JibrilMohamud/cove/pull/711)
creates **one run-specific, secret-gated Worker** with an expiring
12-minute lease. It contains NO primary or staging D1 binding, no
Durable Object, R2, KV, service, queue, AI, analytics, cron trigger,
customer-facing route, or entitlement/payment credential.

The only endpoint is `GET /__cove/rollback`, which requires a fresh
run-only gate header. Ordinary customer catalog requests return 404,
and missing gates return 401. Both versions prevent serving once
the stage lease expires, even if automatic deletion fails.

## Failed first CI attempt (preserved)

[Run 43773313568](https://github.com/JibrilMohamud/cove/actions/runs/43773313568)
failed BEFORE creating a Worker because the generated Wrangler config
resolved `main` from its own directory. Cleanup still succeeded;
Cloudflare read-only settings GET independently confirmed HTTP 404
for `cove-rollback-proof-43773313568-a1`. The entrypoint path was
corrected without relaxing any isolation guard.

## Successful independent stage A → B → A

[Run 43773393952](https://github.com/JibrilMohamud/cove/actions/runs/43773393952)
passed every deployment and cleanup step:

1. Deploy a fresh stage Worker **A** and verify its gated JSON and
   `x-cove-rollback-version: A` header.
2. Prove unauthenticated requests are denied (401), and ordinary
   production routes are absent (404). Verify Worker settings contain
   only the three approved stage bindings.
3. Deploy a distinctly versioned **B** with the same isolated name,
   and verify it is serving through the same gated endpoint.
4. Submit Cloudflare's native deployments API with the exact original
   Worker A version ID, at **100%** traffic.
5. Verify the deployment ID points to the original A version and
   repeated HTTP reads return **A**, not B.
6. Check that the genuine production `cove-persistence-backend`
   remained pinned to version 451,
   `401f2af2-6e69-4611-8110-1d127af6eecf`, at 100%.
7. Delete the temporary Worker via the unconditional `if: always()`
   cleanup, verify its absence, then remove locally generated secrets.

Independent Cloudflare API settings GET confirmed **HTTP 404** for
BOTH test names `cove-rollback-proof-43773313568-a1` and
`cove-rollback-proof-43773393952-a1`. A subsequent read-only
production deployment listing still showed original deployment
`86d49417-d6e5-40cb-a7e4-8245fbf26a09` unchanged.

## Gaps before a real protected production release

This proves the Cloudflare rollback **mechanism**, not that production
version 450 is a safe replacement for 451. Cove's actual persistence
Worker may have different binding compatibility, legal/D1 schema,
secrets, cron effects, Vercel gateway compatibility, and pending
payment/entitlement obligations. A production rollback rehearsed with
the real service plus authenticated, rights-safe reads is STILL needed.

No production script, deployment, routing, D1, R2, Stripe LIVE,
legal-owner switch or customer entitlement was changed by this test.
The release gates remain **BLOCKED**.
