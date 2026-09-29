# Cove catalog identity, discovery metadata, and editorial discovery

Migration `0037_catalog_identity_discovery_seo.sql` makes Cove-native catalog identity independent of source catalogs.

## Identity model

`works`, `editions`, and `products` each have an immutable 128-bit opaque public identifier:

- `wrk_<32 lowercase hex>` — conceptual creative work;
- `edn_<32 lowercase hex>` — a particular language/publisher/content edition;
- `prd_<32 lowercase hex>` — a sellable/readable format product.

These public IDs are the canonical Cove identities for customer URLs, APIs, search suggestions, sitemaps, SEO, Work/Edition navigation, delivery, and new integrations. Existing internal primary keys are retained only as compatibility implementation keys so historical reading/review/entitlement foreign keys do not require an unsafe destructive rewrite. They must not be exposed as new public identity.

Source IDs live in `external_identifiers`. The canonical US Project Gutenberg source may expose `scheme=gutenberg,value=<Gutenberg id>`; regional Gutenberg-family sources keep their own source schemes so an identical numeric source key cannot collide across jurisdictions. ISBN and publisher/partner identifiers are likewise scheme-scoped. `catalog_public_aliases` preserves legacy links and redirects them toward the canonical Cove public identity.

## Normalized discovery metadata

Discovery does not depend on JSON blobs after ingestion. Canonical relationships include:

- `contributors`, `work_contributors`, and `edition_contributors`;
- `languages` and `edition_languages`;
- `subjects` and `edition_subjects`;
- retail/browse `categories` and `edition_categories`;
- `series` and series memberships;
- `external_identifiers`.

Subjects and categories are intentionally different. Gutenberg subjects are descriptive metadata. Gutenberg bookshelves can remain browse-category inputs. Search documents project these normalized relations into separate contributor, language, subject, category/bookshelf, and series fields.

## Work / Edition / Product behavior

A Work is the canonical conceptual title. Its page groups text editions and commercial format products and, for the legacy US public-domain audio pipeline, linked human/computer recordings. This lets a single Work page represent a canonical Gutenberg EPUB today and future annotated, translated, illustrated, scholarly, publisher, and audiobook editions without producing duplicate top-level books.

Legacy public-domain audio remains US-gated until its source evidence is modeled with the same jurisdiction-specific rights records as commercial audio. Commercial audiobook products already use normal Edition/Product rights and offer resolution.

## Editorial CMS

Cove Edit, homepage rows, collections, featured placements, category merchandising, and campaigns are stored in the merchandising database (`merch_slots`, `merch_collections`, `merch_placements`, campaign records) and managed through the staff storefront/merchandising surface. React components consume resolved CMS content rather than hard-coding Cove Edit title selection or homepage curation.

## SEO

Canonical product pages use `/books/<prd_...>`. Work and edition pages use their public IDs. Legacy `/book/<source-id>` links remain compatibility entry points and canonicalize to Cove product URLs. SEO loaders and sitemap shards cover products, Works, Editions, authors, and category browse pages with entity-specific titles, canonical URLs, and Schema.org structured data. Work structured data includes sibling ebook/audiobook examples when applicable.

## Wishlist

Wishlist state is separate from reading shelves/library ownership. It participates in cross-device sync with tombstones and supports release/preorder/price-drop alert semantics without changing the shelf model.

## Invariants

- Public IDs are immutable once assigned.
- New Work/Edition/Product rows automatically receive public IDs and canonical aliases.
- Partner source IDs do not become unscoped global aliases.
- Personal uploads retain private-review restrictions even when addressed through opaque `prd_...` routes.
- Source/cache IDs may be used to fetch source bytes, but must not become canonical customer identity.
