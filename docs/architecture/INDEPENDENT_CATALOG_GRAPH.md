# Independent derived catalog graph and canonical read-path isolation

The catalog capture Worker processes each source revision in an independent
database, where a **single D1 batch transaction** advances the FTS document,
title/description preparation and fully derived graph document together.
The graph materializes contributor names, subject links, shelves, languages
and source asset descriptions under one monotonic source revision.

This graph has **no rights/offer/customer authority** and cannot independently
display, license, sell, or deliver a book. It is never allowed to reverse a
primary legal withdrawal. Old changes may be replayed; the revision fence
rejects them; withdrawal upserts a hidden/empty graph version.

The production `getBook()` handler now only serves *prepublished canonical*
editions. An unprepared Gutenberg ID receives 404 instead of triggering
graph/FTS rebuild and legal-grant creation during customer read traffic.
Nonproduction fixtures keep existing fallback behavior.

Critical remaining release work: primary source ingestion and legacy
`commercialCatalogStatements` still rebuild legal/asset/taxonomy data
in the primary D1, and most application read paths still depend on it.
Move the remaining canonical writers/readers to the independent graph,
retain only minimal synchronized authoritative rights and order state,
reconcile all existing products and sources, and certify dual-coast live
withdrawals before production cutover.

The hosted capacity gate includes external ingress and D1 service tails;
neither isolating graph CPU nor returning HTTP 200 for missing legal books
establishes a strict 800ms maximum. All release thresholds remain unchanged.
