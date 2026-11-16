# Cove protected production rights spot audit — credential and recovery runbook

**Status:** This is a read-only spot test, **not** proof of production release readiness or a substitute for exclusive legal-owner writers.

## Failure #9: no protected read credential

The manual GitHub Actions [run #9](https://github.com/JibrilMohamud/cove/actions/runs/43802179404) failed during the **protected-live-audit** step on November 16, 2026. The earlier **offline-safety** job passed. GitHub supplied an **empty** `COVE_CF_PRODUCTION_AUDIT_READ_TOKEN` value. The script denied execution with `rights_spot_audit_protected_permission_required` **before any D1 network query**. This is missing protected configuration, **not a canonical-rights mismatch**.

### Set the secret without placing it in chat or source

1. In Cloudflare, create a separate API token restricted to **D1 Read** for Cove's production account `d26430caa63ec55f6612e32f36aca5e9`. If the available API policy scope supports narrowing to the exact database `4bd657ac-8789-403e-a28c-93aba8d0a989`, use that restriction. Do **not** grant D1 Write, Workers Edit, DNS, account administration, or API token administration. Never use a broad production deployment token or the staging data-plane credential.
2. In GitHub repo `JibrilMohamud/cove`, go to **Settings → Environments → cove-production-release-audit → Environment secrets → Add secret**, name **`COVE_CF_PRODUCTION_AUDIT_READ_TOKEN`**, and paste the token into GitHub's secure input. Do **not** paste it in a PR, log, issue, commit, or ChatGPT conversation.
3. Ensure the protected environment has a **required reviewer** and restricts deployment branches to **`main`** as appropriate for the repository. The audit's own workflow also hard-requires exact `main`, manual `workflow_dispatch`, the confirmation input and the fixed account/primary D1.
4. Go to [Actions: cove-protected-real-rights-spot-readonly](https://github.com/JibrilMohamud/cove/actions/workflows/cove-protected-real-rights-spot-readonly.yml), select **Run workflow** on `main`, and enter **`RIGHTS_SPOT_AUDIT`**. Start a **new** run rather than rerunning #9, because the original run's workflow uses the original commit and the corrected diagnostic requires a reviewed commit.
5. Check that **Require protected Cloudflare D1 Read token** passes without displaying the value. Then inspect the bounded `cove_prod_rights_spot_audit` aggregate output. Any nonzero `viewOnly` or `canonicalOnly`, source-watermark movement, read-only attestation failure, or absent policy witness must remain a **release blocker**, not be suppressed.

A missing token causes a named, early **FAIL**; a token too short causes a separate named **FAIL**; an invalid GitHub context is denied before credential use. The run's protected secret is scoped only to the preflight and final read-only test steps — **not** to `npm ci`, checkout, or unrelated jobs.

## Limits and release safety

The audit evaluates at most **8** production product IDs and up to **400** single-statement read-only D1 queries. It never writes D1, changes legal grants, activates the production owner, changes Stripe payments, or modifies customer routing. It is not an atomic, full-catalog rights audit; it cannot certify missing contract/version/language/DRM witnesses, the 82,247-book authorization set, search parity, 503 elimination, four-region performance, Stripe LIVE or rollback.

**Production deploy warning:** Merging even audit-only files unexpectedly triggered automatic Vercel production deployment in [PR #717](https://github.com/JibrilMohamud/cove/pull/717). Production aliases were restored to the pinned previous deployment; see [issue #718](https://github.com/JibrilMohamud/cove/issues/718). **Do not merge this runbook/preflight change until actual provider-side production deployment and alias protection is independently certified.** The read-only credential can be installed without a source commit, and existing `main` workflow can then run after the protected environment approves it; the new descriptive diagnostics are optional and should not force an unsafe production merge.
