# Cove SEO, accessibility, and commercial EPUB operations

This document describes the production contracts introduced by migration `0030_seo_accessibility_and_format_support.sql`.

## Organic discovery

Cove renders route-specific metadata during SSR. Public books receive a unique title, description, canonical URL, Open Graph/Twitter image, author metadata, and JSON-LD for `Book`, `Product`, `Offer`, and `BreadcrumbList`. The offer uses the same commerce detail endpoint as the storefront, so structured price and availability are not copied into a second hard-coded price system. Public author pages emit `Person` JSON-LD and canonicalize contributor aliases to the commercial author slug. `/ebooks/*` landing pages take their title, description, canonical target, noindex state, and breadcrumb structure from Cove's retail taxonomy/CMS.

`/store` is a permanent alias and redirects to `/`; it must not compete with the root bookstore URL. `FORE_PUBLIC_URL` is injected server-side into route metadata as the canonical production origin, so reverse-proxy or preview hostnames cannot become canonical URLs. Private imports, drafts, suppressed products, checkout/account/staff surfaces, reader/listener entitlement surfaces, and APIs are not sitemap targets.

The Worker serves:

- `/robots.txt`
- `/sitemap.xml` — one non-nested sitemap index that enumerates every current sitemap shard
- `/sitemaps/pages.xml`
- `/sitemaps/books/<page>.xml`
- `/sitemaps/authors/<page>.xml`
- `/sitemaps/categories/<page>.xml`

Sitemap shards are capped at 20,000 URLs so Cove has margin below search-engine protocol limits. Configure `FORE_PUBLIC_URL` to the canonical production origin so generated sitemap and robots URLs remain stable behind proxies/custom domains.

## Application accessibility

Cove targets WCAG 2.2 AA for customer and creator surfaces. This is a target backed by repeatable audit evidence, not a blanket certification claim. The shell provides a keyboard skip link, visible focus styles, labeled primary navigation, reduced-motion behavior, semantic main content, and labeled reader controls. Checkout, store, reader, publishing, staff, and authentication surfaces should be audited on every material UI release with both automated scanning and keyboard/screen-reader manual checks.

`accessibility_audit_runs` records surface, standard, scanner/version, severity counts, report object hash, and commit reference. Staff with `accessibility.audit.manage` can record an audit through `/api/fore/admin/accessibility/audit`; readers with `accessibility.audit.read` can retrieve the audit ledger. Store full reports in private object storage and persist the SHA-256 in D1 rather than placing report contents in the storefront database.

Minimum release checks:

1. keyboard-only navigation and logical focus order;
2. visible focus at 200% zoom/reflow;
3. accessible names for controls, dialogs, validation errors, and payment actions;
4. screen-reader smoke tests for search → product → cart → checkout and publishing upload → validation → submission;
5. color contrast and non-color-only status communication;
6. reduced-motion behavior;
7. reader operation with NVDA/JAWS + Chromium and VoiceOver + Safari where supported;
8. no critical/serious automated findings without an approved exception and owner.

## Book accessibility

Cove's book metadata contract follows **EPUB Accessibility 1.1** discoverability fields and uses WCAG 2.2 AA as the applicable content-accessibility target; automated inspection is evidence, not a certification by itself.

Cove keeps publisher declaration and automated inspection separate. Publishers must sign one immutable accessibility declaration per eBook edition revision, including when they make no formal conformance claim. The declaration records summary/certification claims and the exact manuscript asset version. Replacing the manuscript makes the prior declaration stale and blocks submission until a new publishing revision is opened and signed against that exact EPUB. Cove independently inspects the current EPUB and rejects a formal conformance claim while that inspection is failing.

The inspection persists:

- primary language;
- visual-adjustment support;
- nonvisual reading support;
- image-alt completeness;
- semantic heading structure;
- reading order/navigation;
- table headers/semantics;
- MathML presence and whether the publisher accessibility metadata explicitly declares the MathML accessibility feature (Cove does not infer accessible MathML merely from detecting `<math>`);
- page/accessibility navigation;
- `schema:accessMode`, `schema:accessibilityFeature`, `schema:accessibilityHazard`;
- `schema:accessModeSufficient`;
- `dcterms:conformsTo` and certification metadata;
- an accessibility summary and validation result.

`publishing_epub_inspections` is immutable. When an approved revision is materialized, its accessibility and format profiles are copied into the immutable publication-version manifest. Activating, updating, or rolling back a publication synchronizes the catalog from that exact manifest. Customers therefore see accessibility claims for the asset that is actually being served, not whatever metadata happened to be uploaded most recently.

Cove does not infer that "no detected error" means universal accessibility. Storefront language distinguishes signed publisher declarations, EPUB discoverability metadata, automated checks, known limitations, and third-party certification data. Signer identity stays in the private audit record rather than being exposed on product pages.

## Commercial EPUB capability profile

Cove records a format profile for every inspected publishing EPUB:

- EPUB/package version;
- EPUB 3 nav / EPUB 2 NCX availability;
- reflowable vs pre-paginated layout;
- LTR/RTL page progression;
- horizontal/vertical writing;
- complex CSS;
- embedded fonts;
- SVG and MathML;
- complex tables;
- footnotes/endnotes;
- dictionary semantics;
- media overlays;
- oversized images;
- accessibility navigation;
- compatibility class and reader-support level.

### Reader behavior

Reflowable EPUB 2/3 receives safe viewport guards for oversized images/SVG/tables while preserving publisher CSS. Reader text size, line spacing, typeface, color, paginated/scroll flow, annotations, footnote links, MathML/SVG, and embedded fonts continue to work through EPUB.js and the sanitizer.

Fixed-layout/pre-paginated books are handled differently: Cove keeps publisher page geometry, forces paginated rendering, and disables typography/scroll overrides that would corrupt a comic, manga, picture book, or other fixed page. RTL books reverse keyboard paging according to declared reading order. Vertical writing remains publisher-controlled CSS and is disclosed as browser-engine-dependent support rather than silently transformed into horizontal text.

Embedded EPUB scripts/forms/frames remain stripped. Commercial publication fails closed when executable scripting or remote network resource dependencies are detected because stripping those dependencies would materially change the edition. The reader still sanitizes them as defense in depth, including remote CSS/asset references, so a malformed or legacy file cannot beacon to third-party origins while being read. EPUB media overlays are detected but are not trusted as Cove's synchronized narration source; Biosync/Cove audiobook timing remains a separate verified pipeline.

### Support policy

- **Full:** ordinary reflowable EPUB 2/3 with supported HTML/CSS/navigation.
- **Supported with limits:** fixed-layout, vertical writing, or features Cove preserves but cannot normalize consistently across browser engines.
- **Preview only / unsupported:** reserved for future validators when a production rendering service finds content Cove cannot safely serve.

External validation workers remain required for EPUBCheck/render/device-compatibility jobs. Inline inspection is a deterministic admission layer, not a replacement for EPUBCheck or device/browser rendering QA.

## Operational cadence

- Run external EPUBCheck/render/device compatibility for every new manuscript asset version.
- Run accessibility audits on every material UI deployment and quarterly even without major UI changes.
- Rebuild/serve sitemaps from live catalog state; do not generate static files from publisher metadata.
- Monitor structured-data errors in search-engine tooling and alert on sharp drops in indexed books/categories.
- Treat accessibility-profile changes as publication updates: they require a new immutable manuscript/publication version, never an in-place rewrite of historical evidence.
