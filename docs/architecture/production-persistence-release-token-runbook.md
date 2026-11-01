# Cove production persistence: isolated release credentials

**Release state: blocked until owner certification, live payment verification,
exclusive canonical D1 ownership, geographic capacity, and protected rollback
pass.** This runbook does not waive any gate.

## Production deployment identity

`.github/workflows/deploy-persistence-backend.yml` runs only by deliberate
`workflow_dispatch` from `main`. It rejects alternate Worker, canonical D1,
media bucket, or unreviewed HTTPS origins. A main merge alone does **not**
deploy or run D1 migrations. It checks the disabled owner **before** any
mutation; it checks the exact binding and secret-authenticated handshake after
deployment. A revoked or missing credential is a hard failure, not a green
"skipped deployment."

## Rotate away from the overbroad GitHub account token

The previously observed `Cove GitHub Deployments` account token has Workers
Admin and D1 Write among hundreds of permissions. It is not approved for this
production pipeline.

Provision these secrets in GitHub Actions only after separately reviewing the
exact Cloudflare permission scopes. Do not paste secret values into GitHub
commits, PR comments or chat:

* `CLOUDFLARE_COVE_RELEASE_DEPLOY_TOKEN`: a dedicated account-owned
  Cloudflare API token with only the Workers Editor and required read/deploy
  permissions, scoped as narrowly as Cloudflare permits to the existing
  `cove-persistence-backend` deployment. Do not grant account-wide Workers
  Admin, D1 Write or unrelated product permissions. Verify exact effective
  resource scope; a token capable of writing arbitrary Workers is not an
  exclusive-owner certificate.
* `CLOUDFLARE_COVE_RELEASE_D1_MIGRATIONS_TOKEN`: a **different**,
  short-lived credential issued only for a reviewed, necessary schema
  migration, with just the D1 migration permissions and resources needed.
  Supply it only when `apply_migrations=true`; revoke it after the
  migration and independently verify revocation.

The other production Worker deployment workflows also require **separate**
credentials. `CLOUDFLARE_COVE_RELEASE_GATEWAY_TOKEN` is for the disabled
`cove-fast-customer-gateway` only; `CLOUDFLARE_COVE_RELEASE_LEGAL_OWNER_TOKEN`
is for the **disabled** legal-owner Worker only. Neither is interchangeable
with the backend deployment token, and neither should have D1 Write.
Cloudflare token policy should be independently reviewed for precise account
and Worker scope before either secret is provisioned. Those deployments
require an explicit workflow dispatch on `main`; pushing code alone never
uses their production release credentials.

The workflow refuses reuse of the same credential for deployment and
migration. Never fall back to the old `CLOUDFLARE_API_TOKEN` secret. GitHub
Actions cannot safely infer that a token called "scoped" is actually scoped:
independently inspect Cloudflare's exact token policy and resources before
release.

The legacy account-wide token may still be used by other workflows and must
be separately inventoried, replaced at each consumer, and revoked only after
its consumers are proven to work with restricted credentials. Its presence is
a **release blocker** even though this pipeline refuses to use it.

## Required release rehearsal (not yet certified)

1. Confirm production owner independent positive/negative legal, settlement,
   refund, entitlement and withdrawal proofs; replay, concurrency and
   interruption tests must pass against the exact full production schema.
2. Prove that every HTTP and scheduled canonical write originates solely in
   the legal owner; retire `cove-persistence-backend.DB` and other direct
   principal capabilities, including API credentials.
3. Complete the Stripe LIVE signed event, financial/rights/refund/revocation
   journey without double charges or unauthorized access.
4. Pass native and HTTP/2 cold/warm geographic ORD/LAX/IAD/DFW checks at
   concurrency 1/4/8/16/32 with maximum TTFB below 800 ms, and both 20-second
   100-RPS phases with 2,000 valid responses each, p95 below 600 ms, p99
   below 750 ms, max below 800 ms and zero drops.
5. Rehearse protected Cloudflare-to-Vercel rollback including customer access,
   payment webhooks and deny-first rights withdrawal.
6. Obtain reviewed, successful CI for the merged code and explicit production
   release authorization. The manual workflow is not a replacement for those
   proofs.

Cloudflare official guidance: https://developers.cloudflare.com/workers/authorization/
and https://developers.cloudflare.com/workers/authorization/workers/ .
