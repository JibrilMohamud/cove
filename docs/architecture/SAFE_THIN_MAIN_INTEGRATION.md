# Safe isolated storefront integration — 2026-10-21

This change integrates only the **non-routable isolated evaluation Worker** and its tests into main. It is **not** a replacement for Cove's customer storefront and does not certify live 100-RPS capacity or interactive feature parity.

## Invariants

- `workers_dev=false`, `preview_urls=false`, no routes/custom domains and no scheduler.
- Staging-only, exact synthetic D1 binding and explicit `isolated-evaluation` flag. The Worker fails closed for incorrect/missing flags or database identity.
- A separate 64-character bearer is required for stage ingress. That bearer must never be sent to CORE as an app identity; optional internal CORE credentials must differ.
- Only anonymous plain GET `/` is rendered with the existing live primary-D1 rights-checked canonical bootstrap; customer sessions, checkout, library, reader, and all other paths delegate to existing CORE.
- No independent rights cache, private candidate projection, new product authorizer, production migrations, feature activation, D1 writes, or new production path.
- New CI performs source/config safety checks, four-country live-rights/revocation regressions, rate limiter, login delegation, HTML escaping, isolated build, and strict TypeScript, without Cloudflare credentials or deployment.

## Deliberately not accepted as live release evidence

The synthetic thin prototype has different storefront UI and has not established production interaction parity. Existing storefront retains all customer routing and experience. Its own LCP and production performance have not been modified by this main merge.

## Activation boundary

The high-severity Vite/launch-editor advisories in the old main lockfile are corrected by reusing the separately CI-validated lock-only update from PR #249, without altering root package declarations. Because main previously deployed the production persistence Worker and applied D1 migrations on every lockfile-only change, its deployment workflow no longer auto-runs for lockfile-only or workflow-only changes; explicit manual dispatch remains available.

No production activation is authorized by this merge. Any future route cutover requires its own candidate PR, user-journey parity (including save, locale, discovery, search/filter, checkout, reader, protected audio), live rights tests, explicit deployment approval, staged canary and rollback.
