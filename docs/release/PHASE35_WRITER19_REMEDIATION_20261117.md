# Protected phase #35 and physical writer audit #19 remediation (Nov 17, 2026)

## Source evidence and release decision

Both manually dispatched workflows ran on approved main
`8218e732aa0c95980b29cb55cc51839cde82b813`, independently protected
by the `cove-production-release-audit` environment and exclusive real-primary
release lock.

- Phase #35 failed BEFORE the first licensed SSR GET. Wrangler 4.151.0
  uploaded `cove-canonical-phase-readonly-staging`, then rejected its own
  `GET /accounts/.../workers/workers/<name>` with Cloudflare 10007
  ("Worker does not exist"). The previous design always DELETED each
  isolated Worker, forcing a new Worker creation on every future run.
  Cloudflare's 2026 Workers role model requires product-level Admin to
  create new Workers, while the protected deploy token intentionally only
  carries Workers Scripts Write. No legitimate phase results exist for #35.
- The old independently scoped cleanup succeeded and postflight proved
  production versions unchanged and both temporary Workers absent.
  Follow-on stage-check and evidence-verifier errors were consequences
  of the missing deployment, NOT separate D1 or latency failures.
- Writer audit #19 passed its offline and exact-main-source guards, then
  stopped because `COVE_CF_ACCOUNT_TOKENS_AUDIT_READ_TOKEN` and
  `COVE_CF_USER_TOKENS_AUDIT_READ_TOKEN` were both EMPTY in the GitHub
  protected environment. Metadata read was installed. The writer audit
  therefore did not inventory or certify competing principals.

Both release gates remain **NO-GO** until independently proven. The prior
protected 120-sample stage run #24 still failed the hard 800 ms TTFB gate.

## One-time parked Worker bootstrap (completed via reviewed account action)

To avoid a continuously privileged admin token in GitHub and to allow
the protected deploy token to edit existing records with no permission
increase, the two exact, *nonproduction* Workers were created once with
**only a deny-all HTTP 401 stub, no bindings, no routes, and disabled
workers.dev and preview URLs**:

| Stage Worker | Immutable deny-only version, 100% |
|---|---|
| `cove-canonical-phase-readonly-staging` | `06a9b74b-572f-4f2d-affd-c2cfce31d5f2` |
| `cove-storefront-phase-staging` | `9ad726e2-8ac9-466c-b945-a14fdf290265` |

The deployed version pins, absence of bindings, inactive workers.dev URLs,
disabled preview URLs, and absence of custom domains were separately
confirmed through Cloudflare metadata endpoints. Both *modern*
`/workers/workers/{name}` records also exist. The three production Worker
pins and owner-disabled legal state were not changed.

The protected phase job must now:
1. Require both exact parked versions at 100%, read their **version-specific**
   `resources.bindings`, require zero bindings, require both workers.dev
   and previews disabled, and require no custom domains. Any mismatch
   fails before a deployment or secret upload.
2. Verify the existing deploy token's narrow Workers Scripts Write policy
   and a distinct, read-only D1 token. Do not add product-level Workers
   Admin to a long-lived CI token.
3. Deploy phase reader and gated SSR over these *existing* two records,
   without customer domains or production D1 bindings; retain complete
   SQL/REST/RPC timing and 32 paired 401 negative controls.
4. ALWAYS restore the two exact pinned deny-only Worker versions to
   100%, consumer first, then provider, and disable workers.dev and
   preview ingress. Independently verify both postflight states and
   unchanged production versions even if a test or upload fails.

**Cloudflare semantics validated on a non-routable isolated reader:**
`GET /workers/scripts/name/settings` continues to expose the most
recently uploaded version's bindings after an old safe version is
redeployed. Therefore parked checks must query
`/workers/scripts/name/versions/{deployed_pinned_version}`
and inspect its immutable `resources.bindings`, not latest settings.

The parked versions are **not** a replacement for the owner contract:
rights-positive reads still require fresh primary-backed legal decisions.
When live stage SSR is enabled its gate must require an ephemeral
bearer and enforce no-store; when idle, the Worker has NO public ingress.

## Missing protected writer-audit credentials (operator action)

In GitHub repository Settings > Environments >
`cove-production-release-audit` > Environment secrets, add exactly:

- `COVE_CF_ACCOUNT_TOKENS_AUDIT_READ_TOKEN`: an account-owned
  Cloudflare token scoped only to Cove account with **Account API Tokens
  Read** (no Write, D1 Write, Workers Admin, or deployment capabilities).
- `COVE_CF_USER_TOKENS_AUDIT_READ_TOKEN`: a **user-owned** Cloudflare
  API token with **User > API Tokens > Read**, with no other privileges.
  This is a different scope/issuer from account-owned token inventory;
  account-token Read does not grant access to `GET /user/tokens`.

Keep the existing `COVE_CF_WORKERS_METADATA_READ_TOKEN` unchanged.
Never store any token value in source, issue comments, CI logs or chat.
User tokens may only enumerate the creating user's tokens; the
source audit must explicitly fail if it cannot prove complete authority
across every relevant token principal.

The protected writer workflow now checks for all three credential
variables independently before any live inventory. Once installed,
the audit may **still fail correctly** on the known disabled production
legal owner, native non-owner primary D1 Worker bindings, or broad
active account tokens. Do not mark exclusivity certified merely
because the missing credentials were supplied.

## Remaining release gates

Exact same production pins, deny-first rights, no unauthorized D1
writes, full catalog/503 elimination, cold and warm max TTFB <800ms
at 1/4/8/16/32, ORD/LAX/IAD/DFW repeatability, both 20-second
100-RPS phases, Stripe LIVE settlement->entitlement->protected
delivery->refund->immediate revocation, protected rollback, and
enforced main branch rulesets remain separately required.

No customer routing, D1 rows, production legal authority, Stripe
mode, live entitlements or production Worker versions were changed
in this remediation.
