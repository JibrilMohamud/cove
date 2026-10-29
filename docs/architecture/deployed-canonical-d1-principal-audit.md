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

## Required retirement sequence

1. Independently record every scheduled/HTTP/queue/service caller for each publication driver, capture, literary and music publisher. Trace the full transitive service-binding graph; a worker with zero direct cron and public ingress may still receive service calls.
2. Confirm each process is paused/finished with deployed runtime evidence and no unresolved leased jobs or write side effects. Prepare a tested rollback deploy that preserves original secret bindings and Durable Object state.
3. On a controlled deployment, move nonauthorizing reads to isolated catalog/content DBs, move canonical protected mutations to owner-first domain executors, and drop direct canonical production D1 capabilities. Remove unnecessary triggers only after verifying downstream consumer health.
4. Re-run this account-wide audit after **each** isolation batch. Do not treat a `workers_dev=false` config as a write-isolation fence, and do not create a read-only D1 permission in documentation that Cloudflare's binding does not enforce.
5. Verify source SQL review, committed production topology, live service binding identities, all external D1 API token principals and actual production positive/negative rights flows before promoting owner-only production.
6. Preserve existing Vercel public routing and rollback policy until commercial entitlement, customer media, performance and geography checks pass.

## Scope

This work does not claim that all 426 reviewed owner-required mutation candidates are certified; it does not modify live schedules, rights, the production legal owner, Vercel routing, or permissions. The 57 production-D1-bound Worker scripts remain an independently observed release blocker.
