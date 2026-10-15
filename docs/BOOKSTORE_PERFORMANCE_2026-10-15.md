# Bookstore first-load investigation — 2026-10-15

## Reproduced baseline

Production HTML had no book cards: it rendered “Finding books…” and skeletons, then needed JavaScript/hydration and a separate catalog request before usable books appeared. A read-only production probe measured HTML TTFB 4.13 seconds and catalog TTFB 4.58 seconds; subsequent probes measured 3.47 and 4.84 seconds. These are measurements from this execution environment, including its network/proxy path, not field Core Web Vitals or universal response-time claims. The HTML probe was a Vercel cache HIT; caching that empty shell did not eliminate the later catalog dependency.

The client also independently requested storefront context, page configuration and category taxonomy. Each backend handler resolved storefront context separately. Locale/account resolution could change query keys after the initial fetch. Editorial/recommendation modules inserted above the catalog after loading, moving the first-page books. All cover images were lazy, even the first visible row. Browser traces confirmed that Google Fonts stylesheets were blocked by Cove's own CSP while their preconnections still ran.

## Changes

- Add one rights-filtered `/storefront/bootstrap` endpoint: resolve context once, then fetch catalog, page configuration, categories and market options in parallel.
- Fetch the bootstrap in the homepage route loader and render actual catalog cards into the initial HTML. Reuse the exact locale, currency, region and query data in React Query so hydration does not repeat those requests. Filtered/authentication URLs retain their normal explicit query behavior.
- On Vercel, use the configured backend directly for bootstrap and SEO instead of making a second round trip through the frontend function. Bound bootstrap to five seconds and SEO to four seconds; preserve client fallback and recovery if bootstrap fails.
- Honor caller cancellation across the persistence gateway so a bounded loader cannot wait for its old 30-second gateway timeout.
- Keep the loaded home route fresh for one minute during client navigation. Catalog/query cache keys still include account, region, currency and locale.
- Move optional discovery modules below the stable catalog. They cannot delay or push the initial book cards downward when they arrive.
- Prioritize the first cover row, provide image dimensions and asynchronous decoding; leave later covers lazy.
- Remove CSP-blocked external font requests/preconnections. Existing permitted system fallback fonts remain in use.
- Mark homepage HTML private/no-store: it now contains region/currency/locale-specific book data. Invariant legal/audio shells retain their separate public cache policy. Do not trade legal availability or account isolation for a shared HTML-cache hit.

## Verification

A local HTTP render with real fixture database/API data returned 23 book cards in the HTML before JavaScript, taking 1.47 seconds including development transforms; the combined fixture API handled its request in 25 milliseconds. These fixture measurements are not production latency results.

The API regression compares bootstrap and ordinary catalog projections across US, Canada, Saudi Arabia and Japan, checks selected currency, and verifies that no private reading records are in the bootstrap. Browser regressions check JavaScript-disabled reading of the catalog and hydration without repeated catalog/context/taxonomy/page requests. They also retain filtered-navigation cache behavior, sharing and real offline storage checks. Production post-deployment measurements and browser results must be recorded before claiming a completed performance release.
