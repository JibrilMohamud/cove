# Cove reading, localization and content release audit — 2026-10-15

This is a release candidate based on main `00afef6` (PR #27). Changes are committed locally on `fix/coverage-localization-journeys`. Publication is blocked by automatic approval review, which requires current-chat authorization naming `https://github.com/JibrilMohamud/cove`. No production migrations, Worker variables, signing keys, payment keys, or catalog rights were changed during this work.

## Implemented

- Add 728 UI phrases for en-US, es-ES, fr-FR, de-DE and ar-SA. Cover static JSX text and accessible labels in Reader, Community, Sharing, Collections, Audio, Stats, Auth and RequestFailure; localize many additional status messages and complete-sentence substitutions. Authentication includes login, signup, verification, password recovery, password visibility, passkey/MFA captions and linked legal consent. Translate whole consent sentences with React slots so links can move with the language without accepting HTML. Keep machine identifiers, query values and CSS classes independent of translated captions. Check placeholder parity and missing strings in CI.
- Use ISO currency minor units in the remaining audio, store, series, account, checkout, publishing and financial-operations price formatters, generated invoices and payment/payout notices. JPY/KRW use zero fraction digits and KWD uses three. Percentage/basis-point calculations retain their separate units.
- Give reader sheets explicit heading focus and restore the actual opener on dismissal. Preserve visible controls when focus returns. Name passage controls with chapter and quoted passage, preserve expanded/controlled states, and name EPUB frames with book text/title. Preserve or supply the EPUB document language.
- Commit offline EPUBs and audio independently from the browser's optional persistent-storage permission. An unanswered, declined or failed permission request cannot hold the download open. A real Firefox run reproduced the awaited-permission hang and passed after the fix; the cross-browser regression also leaves this optional permission deliberately unanswered while verifying native storage.
- Run stored-asset maintenance independently from catalog discovery every minute. Default to at most 32 serial attempts per tick, with a 50-second work-start window, an atomic two-minute singleton lease, per-file claims, recoverable stale downloads, cumulative outcomes and source fairness. Read a bounded indexed queue frontier per source rather than ranking the full backlog every minute. Respect source disabling and persisted upstream Retry-After for 429/503. Do not bypass regional canonicalization, rights evidence or quarantine.
- Validate ZIP size bounds, EPUB mimetype, XML package/container and local manifest/spine references before marking a newly downloaded US EPUB stored. Regional canonicalization remains an additional gate.
- Audit up to 24 audio track/map objects per minute using R2 HEAD checks. Persist evidence bound to current recording/text/map hashes and expire evidence after 24 hours. Missing/replaced objects cannot count as prepared/checked. File-presence evidence is distinct from decoding/ASR validation.
- Prioritize audio jobs that finish a recording's remaining tracks/maps, before duration tie-breaking. Preserve job leases, retry limits, and the existing paused/budgeted audio-compute controls.
- Report prepared tracks, checked passage timing, complete recordings and all-track timing separately. Never infer whole-book text coverage from map count or from timing every track: an abridged recording can match exact passages.
- Accept mode-matched Stripe restricted API keys. Make webhook processing lease-based and retryable after failure; reject changed payloads for an existing event ID, concurrent deliveries, bad/stale signatures, mode mismatch, and success events whose PaymentIntent, received amount or currency differs from the order.
- Replace social source-layout assertions with actual sharing, revocation, spoiler, journey, paging and access-control scenarios. Keep database/FK contracts. Security CI blocks on strict TypeScript and executes localization, ingestion, webhook and journey behavior. Browser CI exercises six browser/device configurations.

## Production evidence collected during this audit

These are database records at the read-only audit snapshot, not a new physical audit of every stored file.

| Evidence | Count |
| --- | ---: |
| Completed EPUB storage records | 4,820 |
| Pending/retry EPUBs | 26,942 |
| Failed EPUB records requiring review | 1,311 |
| Audio editions | 56 |
| Declared audio tracks | 962 |
| Timing-map records | 96 |

The old audit's 17,621 active-product figure was not remeasured. Job counts or map counts do not prove storage presence, complete recordings, or full-text coverage. The new storage evidence tables are empty until deployment and scheduled verification. A configured attempt ceiling is not a completion ETA: upstream limits, validation failures, deadlines, rights review and new discovery affect progress.

## Validation

Passing local checks: strict TypeScript, non-regressing lint, both application/Worker builds, secret scan, ISO currency tests, wired and source-label localization checks, signed/encrypted EPUB receipt tests, native backend reader/SSR/offline authorization, restoration, statistics, account pagination/isolation, regional Gutenberg, search/updater/cache, notifications, compute budget, hosted BioSync chunks, social/journey/paging and Stripe webhook tests. Dependency audit found four moderate advisories and no high/critical advisories; the high-severity gate passes. Existing lint debt remains visible (2,933 known errors; no increased groups).

All 20 initial Chromium browser scenarios passed. The final six-configuration matrix is tracked below; earlier diagnostic runs are not release evidence. Cold-load diagnostics led to explicit hydration gates and SDK prewarming in the test server. Locale HTTP fixtures block service workers so they remain interceptable across document navigations; the independent sharing/offline suite retains the real worker and native browser storage.

Final browser matrix: locale/accessibility cases PASS (30/30, all five languages across all six configurations). The 90 journey scenarios are being run sequentially with one worker per browser, matching CI. A diagnostic combined run with two workers exceeded this private VM's memory; its connection failures are excluded from release evidence.

Continuation verification: strict TypeScript, non-regressing lint (2,932 known errors and 51 warnings; zero new/increased error groups), both builds, secret scanning, source-label/placeholder checks, five authentication modes rendered in all five locales, linked-consent escaping, localized error references, stored-content coverage, search/updater/cache, sharing/privacy/pagination/erasure, reader SSR/offline authorization and Stripe webhook regressions all pass. The auth render tests are part of `test:ui-localization` and therefore run in security CI. They substitute the dialog portal only to inspect content without a browser; they do not validate keyboard interaction, authentication submission or assistive technology.

The prior browser counts above are inherited evidence from the preceding session, before the authentication changes. The continuation could not recover the private test VM or its reports. Vercel's sandbox session-list endpoint returned HTTP 403 for the explicit Cove team/project, and no Vercel CLI is available here as a fallback. Local Firefox launch confirms that this checkout has no Playwright browser executable. No new browser journey results are claimed, and the remaining journey matrix plus browser checks of the changed authentication UI remain release gates. A fresh authorized browser runner is required; repeated attempts against the same rejected endpoint will not establish coverage.

The native browser storage scenario also saves a real fixture EPUB, disconnects the browser, and checks canonical/source-ID reads and metadata recovery against real IndexedDB. This is separate from a complete production PWA cold-start audit.

## Stripe sandbox evidence and boundary

The connected test account successfully created and retrieved a $1.00 USD synthetic Checkout Session in Spanish, tagged as Cove sandbox QA. It is unpaid. No live charge or licensed catalog product was created. This account's connector exposes Checkout Session creation but not PaymentIntent creation or Checkout Session expiration; Cove currently uses PaymentIntents. The sandbox smoke therefore proves API access/session creation, not Cove's complete payment/entitlement/delivery chain. Signed webhook tests run locally with fixture secrets and synthetic events; they are not evidence of real Stripe delivery to production.

## Assistive-technology audit boundary

Runtime keyboard focus, roles, accessible names, expanded state, dialogs, rendered text and axe checks are automated behavior evidence. No independent human NVDA, VoiceOver or TalkBack session has been performed. These checks cannot certify spoken reading order, browse-mode page turns, caret selection of EPUB text or native announcement quality.

Required manual sessions: NVDA with Firefox/Chrome on Windows, VoiceOver with Safari on macOS/iOS, and TalkBack with Chrome on Android. For each, record the OS/browser/AT versions, reader language, task result and any spoken output defect:

1. Navigate landmarks to a book, enter the EPUB frame, announce title/language and read paragraphs in order.
2. Turn pages in browse mode, return to a bookmarked position, and check focus/reading order after a chapter change.
3. Reach a passage contribution by keyboard/AT navigation and hear the chapter and passage rather than only a dot/count.
4. Open the contribution, hear its heading/audience, react and reply; dismiss with Escape and verify the originating passage button receives focus.
5. Select a passage, save a private note and share it with one named member. Confirm the recipient and note inclusion are announced before publishing.
6. Inspect the recipient's inbox, attempt a spoiler-locked passage, withdraw sharing and verify both DOM and server access disappear.
7. Save a public EPUB offline, close/reopen the production installed app with networking disabled and resume reading. Reconnect and verify one replay of queued mutations.
8. Switch to Arabic and repeat dialog, control, number and passage-navigation checks; preserve the source book's own language/direction.

## Remaining completion gates

- User authorization accepted by automatic review, public branch/PR creation, required GitHub checks, migration/deployment and production smoke.
- Backfill and storage-verification runs in production, plus review of terminal failures/rights exceptions. This revision does not instantly populate the backlog.
- Full-app localization beyond the eight checked components: account-management, shell/footer labels, commerce, notifications, support, legal, publishing/admin surfaces, provider/API error messages and some dynamic prose still need separate coverage and native-language review. Authentication text now has render coverage, but native-language and browser/AT review remains required.
- Independent native screen-reader sessions and a production installed-app cold-start/offline journey.
- An authorized licensed edition and actual sandbox PaymentIntent checkout → signed provider webhook → entitlement → protected delivery/renewal/refund. Public Gutenberg content cannot validate publisher license restrictions.
- Outbound email/push provider bridges are still absent on the authoritative backend; Supabase sign-in email is a separate service.

## Release and rollback

Apply migrations 0054 (runner evidence, source backoff, media checks) and 0055 (webhook leases) before deploying the Worker. The new cron is `* * * * *`; retain the five existing schedules. Set `FORE_ASSETS_PER_MINUTE=32` and make catalog-only ticks use zero asset attempts. Production deployment uses `--keep-vars`, so inspect the effective variable after release; old dashboard-owned variables can outlive source defaults. Audio compute remains paused with its existing monthly cap.

Rollback the code without dropping the additive tables/columns. Disable only the new asset runner by setting `FORE_ASSETS_PER_MINUTE=0`; source backoff and per-file state remain resumable. Preserve all production bindings, rights determinations and cryptographic secrets.
