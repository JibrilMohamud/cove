# Deployed canonical D1 principal isolation — independent release blocker

Audit date: October 29, 2026. This is a **read-only capability inventory**, not an exploit report or proof of authorization.

## Verified Cloudflare account facts

- Live account inspection returned **450 deployed Worker scripts**, all Cove-named; **57** had a direct Cloudflare D1 binding to the production canonical database.
- Of those 57: 44 publication-capture scripts, 7 literary-processing scripts, 2 fast architecture/customer gateway scripts, and 4 production/core/stage scripts (including the disabled production legal owner).
- Six canonically bound scripts have installed cron schedules: persistence, Sounds publication, continuous publication-capture QA, literary handoff draining, literary inference isolated-disabled, literary prepare draining. The persistence Worker has **six individual schedules**.
- Several workers labeled "disabled" or "draining" have `FORE_CONTENT_*_ENABLED=1`, and minute cron triggers. Names do not control execution.
- **43/44 publication-capture scripts have incoming service bindings** from their paired publication drivers. They are not demonstrated to be unreachable, even though their Workers.dev subdomains and cron schedules are disabled. The 44th (`cove-pub-qa-continuous-capture`) has a minute cron. Do **not** bulk-delete or remove their production D1 bindings on the assumption that a lack of public routes proves inactivity.
- The production legal owner has `COVE_RIGHTS_OWNER_ENABLED=0`. Both application Workers and independent Cloudflare script credentials still have the capability to access the same canonical D1 data plane.

## New independent live auditor

`scripts/audit-live-canonical-d1-principals.mjs --audit` inspects the entire account's deployed Worker inventory, D1 bindings, cron schedules, Workers.dev exposure, custom zone routes/domains and incoming service references. An unavailable Worker settings response or unknown exposure causes failure. It never inserts, updates, or deletes a Cloudflare resource.

## Pinned unsafe baseline (no blanket exemption)

`docs/architecture/deployed-canonical-d1-baseline.json` stores the **observed** 57 direct D1 script/binding pairs and six Worker cron schedules. It is explicitly marked `certified:false` and does **not** mean any legacy writer is authorized or safe.

Every protected live audit compares the currently deployed bindings and schedules with this snapshot. A **new** canonical D1 principal/binding or a **new** schedule on an existing canonically bound Worker fails CI. Removing bindings or schedules is permitted as progress, but production owner activation still fails until separate security and authorization certification. Changes to this baseline require an independently reviewed source change and an updated account-wide read-only capture.

The protected GitHub workflow `deployed-canonical-d1-principal-audit.yml` runs its unit tests without any credentials on pull requests; on every protected `main` commit, daily at 07:13 UTC, or manual dispatch it rechecks Cloudflare using the existing secrets and uploads a 30-day inventory artifact. `--release-gate` **always fails closed**: a zero-binding inventory alone cannot certify owner-state provenance, Stripe entitlement, denial epochs, payment refunds, capacity, or rollback.

## Completed live ingress restriction (2026-10-29)

After independently inspecting all 43 numbered historical publication QA driver Workers, the team applied and verified `enabled:false,previews_enabled:false` on their Workers.dev subdomain configurations. Exactly 43/43 returned the expected disabled state, with **zero failed writes**. Only the Workers.dev ingress setting changed; no source or capture Workers were deleted, no canonical DB binding was removed, and no schedule, service binding, customer route, or production owner flag was changed.

The verified pre/post/rollback snapshot, including all exact Worker names, is retained in `docs/architecture/legacy-publication-driver-ingress-lockdown-20261029.json`. To reverse a single Worker (only after reviewing its private QA gate), POST `{enabled:true,previews_enabled:false}` to its Cloudflare Worker subdomain settings endpoint. No production customer flow relies on this operation for settlement.

The live fleet auditor now queries the **driver endpoints as well as the canonically bound capture services** and marks any reopened Workers.dev ingress, preview URL, new cron, custom route or account custom domain as a security drift failure. This network restriction reduces externally reachable paths but **does not establish canonical mutation exclusivity**: the capture Workers still have production D1 bindings, and callers using the relevant private service binding may remain.

## Completed canonical D1 binding retirement (2026-10-29)

An exact-state, live Cloudflare deployment operation retired **43** historical `cove-pub-{run}-capture` scripts. The preflight required a single known source D1 binding, a single canonical production D1 binding, and the existing execution flag; no cron, Workers.dev, Preview URL, route or custom domain; and exactly one incoming service binding from the corresponding historical driver. All 43 drivers already had Workers.dev disabled, no service callers, no cron, and no production D1 binding.

For each capture, `PATCH /workers/scripts/{name}/settings` changed only the binding list and capture flag: removed production `SOURCE_DB`, retained independent `PUBLIC_SOURCE_DB`, and set `COVE_PUBLICATION_CAPTURE_ENABLED=0`. The Workers and data were not deleted. The live API confirmed **43/43** have the expected settings and a single new Worker version at **100% traffic**. Zero patch or verification errors.

A separate complete account readback confirmed **450 Worker scripts**, initially **14** directly bound to production D1 (13 non-owner + 1 currently-disabled legal owner) after the 43 capture retirements, down from **57** (56 non-owner + owner). That is **43 actual credential/capability removals**, not an audit classification change.

The exact 43 Worker names and break-glass restore schema are preserved in `docs/architecture/historical-publication-capture-d1-isolation-20261029.json`. The unsafe baseline was reduced from 57 to 14; restoring a previously retired canonical D1 binding is now a **new binding regression** and fails the protected drift audit. The audit additionally checks that none of the 43 retired captures is re-enabled even without a production D1 binding.

**Still blocked:** The 13 remaining non-owner D1 bindings include the live backend, customer/fast gateways, scheduled literary processing, production Sounds publication, continuous publication QA capture, and storefront SSR staging. These require separately validated domain write migration or retirement. The 426 source-level owner-required SQL findings remain unresolved, and Stripe + protected media/rollback certification is still missing. The separate owner is still disabled and no public routing was changed. This retirement does **not** certify production authorization.

## Two additional disabled literary Workers isolated (2026-10-29)

After the 43 legacy capture reductions, the account-wide audit and fresh preflight confirmed that `cove-literary-handoff-isolated-disabled` and `cove-literary-prepare-isolated-disabled` were unreachable via cron, Workers.dev, custom routes or incoming service calls, with all execution flags set to `0`. Each Worker previously held both the canonical production `DB` binding and the separate `CONTENT_DB` binding. I removed only the canonical `DB` binding, preserved content D1/R2, and confirmed the new deployment at **100%** traffic. I also updated the checked-in disabled Wrangler configurations so redeployment does not restore canonical access.

The resulting production live inventory is **12 direct canonical D1 bindings: 11 non-owner plus the disabled legal owner**. This is **45 removed non-owner D1 bindings** from the previous 56, while 426 direct canonical SQL mutation findings remain unresolved. The two-Worker evidence and guarded rollback are in `docs/architecture/disabled-literary-d1-binding-retirement-20261029.json`.

Active literary processing, scheduled publication and Sounds jobs, commerce and storefront workers, and other reachable services were explicitly **not** modified. These need owner-first command migration or separate production-safe isolation.

## Fast storefront QA ingress lockdown and locked gateway privilege retirement

On October 29, a separate live Cloudflare preflight found `cove-fast-architecture-qa` had `COVE_STRANGLER_RELEASE_CERTIFIED=1`, production D1 `DB`, a private relay-key secret, and public Workers.dev ingress. It had no cron or custom route/domain; the account-wide audit also found no incoming service-binding caller. **The Workers.dev ingress was disabled and immediately verified**; the production D1 binding still exists and is **not certified** as a read-only capability. Restore `enabled:true, previews_enabled:false` at the subdomain settings endpoint only under a new protected QA ingress review. The account-wide auditor will now block any unreviewed public ingress restoration while this QA Worker has production D1.

A distinct deployed `cove-fast-customer-gateway` is configured with `COVE_STRANGLER_RELEASE_CERTIFIED=0` and returns HTTP 503 before using D1. The new locked-gateway configuration removes its production `DB` binding and `COVE_STRANGLER_DATABASE_ID` selector, with an executable bundled-Worker test asserting every sample account/checkout/storefront path remains 503 **without** a DB binding. The protected deployment must independently verify the live bindings and public responses; source configuration alone is not sufficient. The unsafe baseline remains unchanged until that deployment succeeds.

## Required retirement sequence

1. Independently record every scheduled/HTTP/queue/service caller for each publication driver, capture, literary and music publisher. Trace the full transitive service-binding graph; a worker with zero direct cron and public ingress may still receive service calls.
2. Confirm each process is paused/finished with deployed runtime evidence and no unresolved leased jobs or write side effects. Prepare a tested rollback deploy that preserves original secret bindings and Durable Object state.
3. On a controlled deployment, move nonauthorizing reads to isolated catalog/content DBs, move canonical protected mutations to owner-first domain executors, and drop direct canonical production D1 capabilities. Remove unnecessary triggers only after verifying downstream consumer health.
4. Re-run this account-wide audit after **each** isolation batch. Do not treat a `workers_dev=false` config as a write-isolation fence, and do not create a read-only D1 permission in documentation that Cloudflare's binding does not enforce.
5. Verify source SQL review, committed production topology, live service binding identities, all external D1 API token principals and actual production positive/negative rights flows before promoting owner-only production.
6. Preserve existing Vercel public routing and rollback policy until commercial entitlement, customer media, performance and geography checks pass.

## Scope

This work does not claim that all 426 reviewed owner-required mutation candidates are certified; it does not modify live schedules, rights, the production legal owner, Vercel routing, or permissions. The 57 production-D1-bound Worker scripts remain an independently observed release blocker.
