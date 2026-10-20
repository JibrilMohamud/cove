# Thin storefront interactive experience parity experiment

**Draft; no production approval.** This is a separate branch stacked on PR
#228. It does not replace or merge the thin architecture or change any
production routing. Its purpose is to replace the simplistic beige
proof-of-concept with a dark Cove-inspired, progressively enhanced homepage.

This prototype now includes the original 15 navigation destinations, account
sign-in/create routes, book-category and filter navigation, native search form,
language preference POST to the existing context API, full literary discovery
query and taste controls, a deferred merchandising feed, a conditional PWA
installation prompt with an offline-download fallback, and in-page discovery
results. The same ordered 24 live-primary-rights-checked first-page products,
offers, canonical edition URLs and search fallback remain mandatory. Logged-in
or cookie-bearing requests still go to the unchanged full application, as do
filtered pages, reader, API, checkout and account journeys.

**Safety boundaries:** The module does not import React, TanStack, checkout or
reader; user/content-derived markup is HTML-escaped; discovered books and
marketing cards are rendered using `textContent` and same-origin/internal
links. It does not cache rights or offers. Only synthetic staging enables
`COVE_THIN_EXPERIENCE=1`; the old renderer remains accessible with the flag
off. The inline module contains static behavior (no interpolated visitor or
rights data). Error states show a fallback to the full commerce app rather
than fabricating catalog or authorization results.

**Not certified parity:** the original responsive design, full rich-category
facets, suggestion dropdown, inline account-save semantics, campaign
impression logging and preference persistence for logged-in users remain to
be compared and instrumented. Synthetic 50k-fixture browser searches and
mobile LCP cannot prove production-layout or cover equivalence. Recorded
screenshots, real-catalog visual diffs, keyboard and screen-reader testing,
full account and offline customer journeys, long mixed-load and geographic
rights tests are required before adoption.

The isolated paired benchmark must again pass cold/1–32/100-RPS rights and
mobile gates on a final immutable SHA. **Do not merge to main or change
production routing merely because HTML renders and smoke tests pass.**
