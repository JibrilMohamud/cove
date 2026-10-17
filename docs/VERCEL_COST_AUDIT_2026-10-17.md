# Cove — Vercel cost and performance audit (17 October 2026)

## Billing evidence and limitations

Source: owner-supplied Vercel usage export `vercel-costs.csv`, 107 rows, Cove project ID
`prj_bq7hKQw8JKWE6vpfdOgwowa8cjjM`. Cove's variable usage rows cover
**14–16 October 2026**. The CSV also contains daily allocations of the fixed
Pro subscription through 13 November; those future allocations are not actual
future usage.

| Metric | Usage in export | Recorded charge |
| --- | ---: | ---: |
| Build CPU Minutes | 4,548 billed CPU-minute units | $4.2140 |
| Sandbox Provisioned Memory | 37.888 GB-hours | $0.8032 |
| VCR Storage | 5.522 GB | $0.5522 |
| Sandbox Active CPU | 2.243 CPU-hours | $0.2871 |
| Function Storage | 54.337 GB of reported usage | $0.1811 |
| Fast Origin Transfer | 2.742 GB | $0.1645 |
| Fluid Active CPU | 0.726 CPU-hours | $0.0929 |
| Fluid Provisioned Memory | 6.795 GB-hours | $0.0720 |
| Other Cove charges | — | approximately $0.0436 |
| **Cove usage charges** | | **$6.4096** |

The **$20 Pro subscription** is a separate unassigned, fixed team-level
charge in the same CSV. The figures are usage/charge accounting, **not** a
verified statement of actual cash due after the subscription allowance,
credits, or adjustments. In this sample there is no evidence that requests
or function invocations are the main source of spending (about $0.0054 of
invocation charges versus $4.214 of build CPU charges).

### Ranked cost drivers

1. **Confirmed: repeated deployment builds — $4.214 (65.7% of Cove
   usage).** GitHub alone shows 17 commits on 14 October, 29 on 15 October,
   and 47 on 16 October on `main`. A connected project with Vercel
   Git integration normally builds each commit and its preview pushes, and
   Cove specifies a TanStack app **plus** a separately built FastAPI audio
   service in `vercel.json`. The volume of Git activity and the two services
   are a compelling *contributing mechanism*; **the export does not identify
   specific expensive builds or establish causal allocation per service**.
   **Fix prepared:** production-safe, fail-open, per-service preview ignored
   build steps, diffing against `VERCEL_GIT_PREVIOUS_SHA` rather than a single
   latest commit. This can reduce redundant *preview build CPU* and storage
   growth for unrelated changes. It does not make production builds disappear.
2. **Confirmed: Sandbox allocated memory/CPU — $1.0903 together.**
   The underlying sessions are **not identified** in this CSV; memory
   remains billable during idle time. Inspect **Observability → Sandboxes**
   grouped by Sandbox Name and Session ID to identify idle or oversized
   sessions. Do not kill a user's work or reduce limits without reviewing
   those sessions.
3. **Confirmed: Vercel Container Registry storage — $0.5522, 5.52 GB.**
   Likely accumulated images (Cove has `scripts/Dockerfile.vercel`),
   but the image ownership/lifecycle is **not confirmed**. Inspect
   **Vercel Container Registry** before proposing image retention or
   deleting any artifact.
4. **Measured but not the current cost driver:** backend function execution,
   data transfer, and request volume. The first shelf has had intermittent
   8–10-second cold SSR failures, but eliminating that bottleneck is primarily
   a **reliability/performance** issue at the current reported invocation cost.

## Code changes in the proposed optimization

- `vercel.json`: independently evaluate preview builds of `services.app`
  (TanStack) and `services.audio_pipeline` (FastAPI).
- `scripts/vercel-ignore-build.mjs`: use the prior **successful deployment
  on the same branch**, conservatively classify changed paths, and **build
  whenever the diff is unavailable or has an unknown file**. Preserve all
  production builds, manually triggered/non-preview builds, and cross-service
  changes.
- `scripts/vercel-ignore-build.test.mjs` and security CI: regression tests
  for these invariants.
- Nothing changes live rights, personal data, the storefront's design, SSR
  responses, Cloudflare D1/R2, service bindings, or existing audio interfaces.

The Vercel ignored-build command's exit 0 means *skip*, exit 1 means *build*.
The guard is intentionally conservative. Because each service is independent,
audio-only preview edits need not rebuild the app and app-only preview edits
need not rebuild Python. Cross-service and unknown edits still build both.

## Validation and performance objectives

- CI: strict formatting, TypeScript, security audit, build, audio tests,
  six browser profiles, native NVDA, and the new skip-decision unit tests.
- Before approving production: inspect the **Vercel preview deployment** to
  confirm services remain available when one build is skipped. Confirm
  production builds are never skipped.
- After approval: compare 7-day **Build CPU Minutes**,
  **builds per Git push / per deployed service**, average build duration,
  VCR storage, and concurrent build queue. Normalize to commit counts.
- Independently track the storefront's six-hour **missing SSR book card
  failures**, synthetic cold/warm TTFB, real-user LCP p75, INP p75 and CLS p75.
  Target **zero empty first shelves**, p75 LCP <= 2.5s, INP <= 200ms,
  CLS <= 0.1, with *field* data. Do not treat a build success or synthetic
  TTFB as a field Core Web Vitals measurement.
- Reinspect **Sandbox Active CPU, Sandbox Provisioned Memory,
  and VCR Storage** by resource owner. Do not delete active sandboxes,
  images, service deployments or adjust billing without explicit permission.

## Blockers and decisions

Direct connected Vercel project, deployments, logs and billing endpoints
currently return **403: not authorized for the team scope**. Therefore:
no verified function-duration histogram, image inventory, cache-hit rate,
current deployment-list total, credits, or current paid balance.

To finish financial attribution, grant Vercel connector access to the
**`jibrilmohamuds-projects`** team scope, or provide:
1. **Usage → Build CPU Minutes** by project and daily granularity plus the
   deployment/build listing for 14–16 October;
2. **Observability → Sandboxes** (name, session ID, memory and lifetime);
3. **Container Registry** image/storage inventory and retention;
4. function latency/duration, CPU, invocations and origin transfer for
   the same days, plus current credit and invoice summary.

**No financial savings estimate is justified yet.** Compare charges across
like-for-like subsequent days and deployment activity; Vercel's ignored-build
step still creates/cancels a deployment and can count against deployment
quotas, even when it avoids expensive build execution.

**No production merge/deployment, billing action, resource deletion, or
infrastructure migration is authorized by this audit.**
