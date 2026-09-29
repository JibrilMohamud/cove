# Cove setup and operations

## Runtime and identity

This checkout uses the existing Sites project recorded in `.openai/hosting.json`. Keep that identity when deploying updates. The configured bindings are `DB` (D1) and `BUCKET` (R2). `npm run build` builds TanStack Start and then stages the Worker and Drizzle migrations through `scripts/stage-sites.mjs`.

Production reader identity comes from a verified Supabase Auth user fetched by the Worker. Session cookies are HttpOnly, Secure in production, SameSite=Lax, and never used as an authorization claim without `auth.getUser()`. The existing trusted Sites identity is consulted only during a one-time migration when its independently authenticated email exactly matches the verified Supabase email.

Migration `0002_abandoned_the_stranger.sql` adds reviews, community, shelves, statistics, and audio playback. `0003_curvy_vin_gonzales.sql` adds the verified-provider account directory. `0004_lyrical_queen_noir.sql` adds durable audio jobs, timing-map records, and versioned Biosync positions. `0005_commercial_catalog_foundation.sql` introduces the normalized Work → Edition → Product → Offer/Rights/Entitlement catalog. `0006_commercial_search.sql` adds the search projection, D1 FTS5 fallback, search analytics, and external-index outbox. `0007_commercial_storefront.sql` adds commercial date projections, Cove's hierarchical retail taxonomy, durable browse/landing pages, and the merchandising CMS model. `0008_storefront_operations_hardening.sql` adds conflict-safe taxonomy redirects plus page-view-aware merchandising measurement. `0009_commercial_recommendations.sql` adds recommendation privacy, interaction/features, item neighbors, model/experiment registry, attribution, follows/wishlist and durable jobs. `0010_recommendation_hardening.sql` adds idempotent events, request latency/scorer telemetry, model evaluation and deployment audit. `0011_commercial_product_retail.sql` adds product rankings, preview policies/derivatives/state, commerce wishlist profiles/events/notifications, and an offer-aware cart boundary. `0012_stripe_commerce.sql` adds payment/order/tender operations, `0013_commercial_finance_pricing.sql` adds regional pricing and finance controls, `0014_commercial_rights_management.sql` adds auditable rights grants/decisions, `0015_rights_channel_projection.sql` unifies fail-closed retail/subscription/library availability, `0016_contract_territory_engine.sql` adds global ISO markets, reusable/nested territory sets, include/exclude and historical-successor expansion, contract language rights, exclusivity/conflict analysis, and immutable per-grant territory snapshots, `0017_gutenberg_source_federation.sql` adds jurisdiction-scoped Gutenberg source/evidence ingestion, and `0018_catalog_entities_and_private_exports.sql` adds stable public entity slugs, structured series relationships, work relationships and privacy-preserving export audit metadata. `0019_fore_publishing_foundation.sql` adds creator publishing organizations, compliance/readiness gates, quarantine validation jobs, immutable submissions and idempotent catalog materialization. `0020_publishing_lifecycle_and_moderation.sql` adds the release state machine, immutable publication versions, owner update policies, staff SSO/MFA/RBAC, moderation cases/queues/actions/appeals/sanctions and copyright/reporting workflows. `0021_publishing_activation_and_staff_audit.sql` adds the append-only publication activation ledger and staff-access audit trail. Deploy all migrations in journal order; the catalog migration preserves existing user state while replacing obsolete snapshot tables with normalized references.

## Configuration

| Variable                    | Purpose                                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | Supabase project API URL used by the server-side Auth client.                                                                                                                            |
| `SUPABASE_PUBLISHABLE_KEY`  | Supabase publishable key. Never use a `service_role` or secret key here.                                                                                                                 |
| `FORE_AUTH_MODE`            | Set to `supabase` to enable the app-owned account flow.                                                                                                                                  |
| `FORE_PUBLIC_URL`           | Exact production origin used to build confirmation/OAuth/reset callbacks.                                                                                                                |
| `FORE_GOOGLE_ENABLED`       | Set to `true` only after Google is enabled in Supabase and its redirect URI is configured.                                                                                               |
| Worker service credential | Issue a scoped `fore_svc_…` credential from the staff service-principal API and store the one-time plaintext only in that worker secret manager as `FORE_SERVICE_TOKEN`. |
| Human operations | Human admin endpoints require a provisioned staff identity, MFA/AAL2 when required, and granular RBAC. There is no shared ingestion/admin bearer token. |
| Storefront staff access | Provision `storefront_editor` or narrower permissions; staff sessions—not bearer secrets—protect taxonomy, merchandising, recommendations and localization. |
| `GUTENDEX_BASE_URL`         | Optional private Gutendex metadata service; defaults to `https://gutendex.com`.                                                                                                          |
| `GUTENBERG_MIRROR_BASE_URL` | Optional HTTPS mirror with Gutenberg main/generated directory layout. Defaults to the officially listed `https://gutenberg.pglaf.org`.                                                   |
| `FORE_SEARCH_BACKEND`       | `auto` (recommended), `meilisearch`, or `d1`. `auto` uses Meilisearch when configured and D1 FTS5 as the resilient fallback.                                                            |
| `FORE_SEARCH_URL`           | HTTPS URL for the production Meilisearch cluster. Keep the service private/firewalled where possible.                                                                                   |
| `FORE_SEARCH_SEARCH_KEY`    | Server-side search-only API key. It is never sent to the browser.                                                                                                                        |
| `FORE_SEARCH_ADMIN_KEY`     | Server-side indexing/settings key. Required for automatic index configuration and outbox synchronization. Never expose it through `VITE_` variables.                                    |
| `FORE_SEARCH_INDEX`         | Optional index UID; defaults to `fore_books`.                                                                                                                                            |
| `FORE_SEARCH_EMBEDDER`      | Optional preconfigured Meilisearch embedder name. When set, Cove enables low-ratio hybrid semantic retrieval for text queries.                                                           |
| `FORE_RECOMMENDER_URL`      | Optional private recommendation service. If configured, Cove can call `/candidates` for model/ANN retrieval and `/rank` for second-stage scoring; failures fall back to the in-process hybrid ranker. |
| `FORE_RECOMMENDER_API_KEY`  | Server-only bearer credential for the private recommendation service. Never expose it to the browser.                                                                                  |
| `FORE_RECOMMENDER_MODEL`    | Optional external model key override. The in-app model registry remains the authoritative Cove model/version record.                                                                   |
| `FORE_RECOMMENDER_TIMEOUT_MS` | Per-call latency budget for the external candidate/ranking service; defaults to 700 ms and is bounded to 150–2500 ms. A timeout degrades to local ranking.                              |

In Supabase, keep email confirmation enabled, set the Site URL to the production origin, and allow exactly `/api/fore/auth/callback`. If Google is enabled, its OAuth client callback points to the Supabase project callback URL; Cove's callback remains the post-provider redirect. Configure real SMTP before inviting a large audience. Registration checks the public Auth settings and fails closed if email auto-confirm is enabled.


## Discovery entities, series and private exports

Migration `0018_catalog_entities_and_private_exports.sql` adds public slug identity for contributors/authors, publishers, imprints and series. Slugs are unique within each entity type. Changing a canonical slug preserves the previous slug as a noncanonical alias; new records may not claim an existing current or historical alias. Do not delete aliases merely to recycle a URL.

Series importers should populate `series_memberships.relationship` (`main`, `prequel`, `novella`, `companion`, `boxset`, `related`), `reading_order`, and `display_order`. `reading_order` is the reader-facing sequence and may be fractional for interstitial novellas/prequels. `display_order` is editorial tie-breaking only. Multiple editions of one work should not be inserted as separate main installments unless the series contract/metadata truly treats them as separate works. Series pages compute owned/read/unread/wishlist state from durable customer records, expose current territorial price/subscription/library availability, identify the next unread main installment, and may atomically add an eligible main-series bundle to the cart. Bulk eligibility intentionally rejects duplicate-work editions, preorders/unavailable titles, mixed currencies, partially unpurchasable main runs, and series over the configured safety cap.

The reading-data endpoint is authenticated and rate-limited. It queries only the user’s reading/annotation/definition/session/completion/preview/BioSync records and never digital-asset tables. Full-reader delivery (`/books/:id/epub`) and customer EPUB export (`/books/:id/download/epub`) are deliberately separate: the former follows access entitlements while the latter additionally requires the current EPUB asset to be marked downloadable. Combined private backups are created in the browser by fetching that export-gated EPUB and the separate private-data export; a reader-only edition therefore still permits personal-data export but not book download or a combined backup. Cove does not persist the generated backup archive server-side. `personal_export_events` is metadata-only and must remain free of note text, highlight quotes, vocabulary payloads or archive bytes.

## Commercial search

Migration `0006_commercial_search.sql` replaces substring scans with a two-tier search architecture. Production can use **Meilisearch 1.36+** for typo tolerance, prefix search, synonyms, disjunctive multi-select facets, modern `attributeRank`/`wordPosition` relevance, filterable/sortable commercial metadata and optional hybrid semantic retrieval. D1 maintains Unicode FTS5 plus an English Porter-stemmed FTS5 index as an independent fallback. Both are derived indexes; normalized Work/Edition/Product metadata remains authoritative.

Catalog projection changes populate `search_index_outbox`. The Gutenberg harvester and pipeline flush that outbox opportunistically. Search remains available through D1 if the external engine is unavailable. Private uploads are marked `suppressed` and never sent to Meilisearch. Review visibility/moderation changes refresh rating and review-count search signals.

For an initial production load, set the search variables and call `POST /api/fore/admin/search/reindex?limit=500` with the existing operator bearer token repeatedly until `GET /api/fore/search/status` reports `pending: 0`. Index settings are versioned and applied before documents are loaded. Do not expose either search key to client JavaScript.

Search requests support title/author/series/ISBN/category/publisher text retrieval (including exact Gutenberg/catalog IDs and hyphenated ISBNs); category, language, format, publisher, series, territory, currency/price, subscription/library eligibility, rating/review-count, preorder/new-release/deal and availability filters; and relevance, popularity, trending, release date, ingestion date, price, rating and title sorting. Shopper-facing facet counts are disjunctive, so selecting one category/language/format/publisher/series does not make all of its alternatives disappear. Meilisearch uses the `frequency` matching strategy, while D1 supplies stemming, synonym expansion, prefix matching, exact-identifier boosts and a bounded spelling-correction fallback.

Search and result-click events are recorded for relevance analysis. Click events are accepted only when they match a recent server-recorded result impression, which prevents trivial analytics poisoning. Public search, suggestion and click endpoints are rate-limited per signed-in account or Cloudflare client IP when available. Establish a query-analytics retention/privacy policy before broad public launch.

## Commercial recommendations

Migrations `0009` and `0010` implement a recommendation platform rather than a single “similar books” query. The normalized catalog remains authoritative; recommendation state is derived and can be rebuilt. Candidate generation combines item content/taxonomy similarity, precomputed content and co-read neighbors, user author/series/category/publisher/language/format/price affinities, cohort co-occurrence, popularity/trend, series continuation, followed authors, wishlist price drops, reread candidates, and editorial collections. Private uploads are never eligible. Every final rail is filtered again for active products, release state, territory rights and explicit user hide/not-interested feedback.

The ranker records source-level contributions so experiments can change weights without pretending that all sources contributed equally. Explicit negative feedback also writes negative taste features instead of only hiding one product. Final selection applies author/series/category diversity plus deterministic exploration, and homepage/book surfaces suppress duplicate products across rails. A configured private recommender can add model/ANN candidates through `POST <FORE_RECOMMENDER_URL>/candidates` and rescore through `/rank`; both calls have a strict latency budget and are optional. External score scales are rank-normalized before blending so a 0–1 model cannot accidentally swamp or vanish beside local scores.

Interaction ingestion is rate-limited and idempotent. Recommendation impressions/clicks are accepted only for a server-created recommendation request; a click additionally requires a prior visible impression. Reader-progress buckets, state transitions and short-window page views receive server-derived dedupe keys to reduce client retry/spam amplification. Personalized learning respects `recommendation_privacy`; disabling activity personalization clears learned features and future events are not attached to the user for learning. Users can also disable personalized search or reset the learned recommendation profile.

The active ranker is resolved from `recommendation_models`, not a compile-time constant. `/staff/storefront` exposes model versions, audited activation/retirement, source-weight/diversity/exploration experiments, item-neighbor rebuilds, job draining, metric refresh and 30-day evaluation. Activating a model marks stored user features stale so they are lazily rebuilt against the new version. Scheduled maintenance drains leased/retryable jobs, expires old telemetry, and periodically evaluates model/surface CTR, catalog coverage, clicked position and candidate-source entropy. Request telemetry records candidate count, ranking latency, execution mode (`local`, external candidates, or external rank) and fallback reason.

For a large catalog, the included D1 item-neighbor builder is the durable fallback: it shortlists candidates from shared authors, series and retail taxonomy plus co-read behavior instead of comparing only against globally popular titles. At very large scale, run embedding/ANN retrieval in the optional private recommendation service and keep D1 neighbors as a resilient fallback. Do not make the external model service a hard dependency for storefront availability.

## Commercial storefront, taxonomy and merchandising

Migrations `0007` and `0008` turn the old hard-coded Gutenberg browse page into a source-agnostic retail storefront. Cove owns a versioned hierarchical retail taxonomy under `storefront_taxonomies` / `storefront_taxonomy_nodes`; supplier subjects remain supplier metadata and are mapped into Cove categories through editable mapping rules. Manual edition classifications survive supplier refreshes. Category moves are cycle-checked, preserve descendant paths, queue affected products for search reindexing, and record permanent redirect targets so old category URLs keep a migration path.

Date semantics are deliberately separate:

- **Recently released** uses edition release date and excludes future releases.
- **Recently published** uses publication date.
- **Recently added to Cove** uses the product/catalog ingestion creation date.
- **Recently updated** uses product/search projection update time.
- **Coming soon** uses future release/preorder dates.

Do not collapse these back into one `newest` field. They answer different customer and merchandising questions.

Public browse state is URL-addressable. Canonical category pages live at `/ebooks/<taxonomy-path>`; author, series and publisher pages use stable entity routes; `/bestsellers`, `/new-releases`, `/preorders`, and `/deals` are durable landing pages; arbitrary search/filter state remains shareable in query parameters. Filtered/search result URLs are marked `noindex,follow` while curated/category/entity pages remain canonical index targets. Browser Back/Forward restores filters because the URL is the state source.

The storefront CMS is available at `/staff/storefront`; its APIs require individually provisioned staff identities with scoped permissions and MFA/SSO enforcement. The CMS manages:

- campaigns with draft/published/paused/archived lifecycle, priority, schedule, territory, language and audience targeting;
- stable storefront slots and placements;
- manual and dynamic collections;
- query-driven and personalized rails;
- sponsored-label metadata;
- weighted, sticky A/B experiments;
- taxonomy nodes, mappings, manual editorial overrides and SEO copy;
- durable campaign/landing pages;
- server-side merchandising impression/click analytics and audit history.

At request time, campaign priority and placement sort order resolve conflicts first; equally eligible placements are assigned deterministically using visitor-sticky traffic weights. Experiment variants are derived server-side. A placement impression is recorded only after at least 50% of the rendered unit is visible, is deduplicated per page view, and a click is accepted only after a valid impression for that placement/page view. Product duplication across resolved homepage slots is suppressed. Sponsored placements must disclose the sponsor.

Changing a supplier-to-Cove taxonomy mapping from the CMS triggers batched reclassification of the catalog. For very large catalogs, move this operation to a durable queue/worker rather than relying on one browser-admin request chain; the underlying `syncTaxonomyBatch` endpoint is restartable by edition cursor.

## Commercial product detail, previews, wishlist and cart

Migration `0011_commercial_product_retail.sql` activates the customer-facing retail layer without pretending that a payment processor exists. Product detail responses resolve the normalized edition/product metadata together with the **current territorial retail right and current effective offer**. A null offer means unavailable; it must never be coerced to zero/free. Existing owners may retain their entitlement after a publisher's future-sale right expires, while new sale/sample surfaces use current rights.

Full EPUB delivery is default-deny. Gutenberg-family projects are **not** a worldwide exception: Cove checks source-specific, evidence-backed grants before anonymous acquisition, previews, or full-file delivery. Project Gutenberg US is U.S.-scoped; reviewed Project Gutenberg Canada and Australia records are CA/AU-scoped; European records are activated only for the exact evidenced countries rather than an inferred EU-wide territory. Personal uploads remain owner-scoped. Previously issued lawful entitlements remain the access authority for owners, while every other supplier requires a live entitlement before full-file delivery. Commercial/publisher `source_url` values are metadata only during customer requests: Cove never performs an arbitrary remote fetch from them. Commercial files must be ingested into the configured R2 bucket by a trusted pipeline before customers can read/download them. This is an SSRF and rights boundary, not just a caching optimization.

Cove does not put licensed commercial EPUBs into the browser-wide IndexedDB offline cache yet. If a publisher marks an entitled DRM-free edition as downloadable, the customer may receive the gated EPUB through **Download book**. Personal annotations are never bundled into that file. A separate authenticated **Export reading data** contains personal reading records without book bytes; **Cove private backup** is the only combined format and is explicitly labeled private. Persistent in-app commercial offline mode should wait for a protected device-license/encryption design. Gutenberg public-domain EPUBs may continue using the device-wide offline cache.

Preview policies are managed under `/staff/storefront` (Preview policies) or the `POST /api/fore/admin/preview-policy` operator endpoint. Policies support percent or chapter limits, an independent hard percentage cap, scheduling and versioning. A preview request creates/caches a derivative by `product + asset version + policy version`. The derivative physically omits unselected spine resources and retains only safe image/CSS/font dependencies reachable from selected sample documents; do not change this to a client-side chapter lock. Audio/video/PDF/script/supplemental resources are intentionally excluded. A source-asset update or policy-version update creates a new cache identity.

Preview position is stored in `preview_states`, separate from `reading_states`. On first transition to full access, Cove may copy the CFI anchor into full reading state because the retained sample spine IDs/order are stable, but it must **not** copy `sample_progress`: e.g. 80% through a 15% sample is not 80% through the book.

Wishlist is a commerce primitive, not a shelf. `wishlist_items` stores alert preferences and acquisition attribution; `wishlist_profiles` owns revocable/rotatable public sharing tokens; `wishlist_events` supports funnel measurement; `commerce_notifications` stores generated price/sale/release/preorder alerts. Public wishlist responses contain catalog/offer data only and never reading progress, notes, highlights or recommendation features. `POST /api/fore/admin/wishlist-alerts` runs a bounded rights-aware alert batch; schedule this maintenance regularly in production. When rights/offers disappear, the item remains saved but becomes unavailable and alert generation stops.

`shopping_carts` / `shopping_cart_items` are deliberately pre-payment. Every cart read re-resolves the current offer/right, marks unavailable rows, detects stale prices and excludes unavailable rows from subtotal. Adding requires a currently purchasable offer and keeps one currency per cart. Do not convert this directly into an order without implementing idempotent payment authorization/capture, tax calculation, immutable ledger entries, entitlements, refunds/chargebacks and reconciliation.

## Catalog ingestion

The existing eBook ingestion routine checkpoints pagination, respects retry delays, and accepts records only when `copyright === false`. The Worker exports a `scheduled` handler and performs limited opportunistic ingestion when the catalog is requested. This does **not** configure a cron trigger on its own: configure the host's schedule or an operator job. `/api/fore/ingestion` exposes progress. A failed upstream lookup does not justify assuming unknown rights are public domain.

Regional public-domain ingestion is source-federated rather than an expansion of the US grant. `pg_ca` stages Project Gutenberg Canada and can activate only `CA`; `pg_au` stages Project Gutenberg Australia and can activate only `AU`; `pg_eu` has no default territory and accepts only a reviewed manifest containing exact country codes plus content-addressed rights evidence. Set `FORE_GUTENBERG_EUROPE_FEED_URL` and `FORE_GUTENBERG_EUROPE_TRUSTED_ORIGINS` for that reviewed feed. Canada/Australia may use their default catalogs or the corresponding catalog override variables in `.env.example`. Each source has independent lease, cursor, snapshot hash, retry/backoff and ingest-run audit state.

Regional items stay pending until Cove has produced a verified canonical EPUB. Native EPUB is preferred. If a trusted Canada/Australia or reviewed-Europe item has only HTML, the worker converts it to a bounded EPUB3 in R2; this never occurs in the customer request path. Permission-only/copyright notices, residual source licence/trademark boilerplate, untrusted asset hosts or evidence mismatches quarantine the item and suspend source-derived grants. See `docs/GUTENBERG_FEDERATION.md`.

Audio uses the Gutenberg RDF catalog because a MIME-to-URL dictionary loses multi-track recordings. The production path is:

```sh
python -m scripts.audio_pipeline.bootstrap --cache /persistent/fore-audio
python -m scripts.audio_pipeline.runner --stdin --cache /persistent/fore-audio \
  --minutes 30 --max-jobs 100 --threads 4
```

The first command refreshes the official bulk metadata and emits a restartable catalog. The worker also consults the daily feed, verifies each RDF record, preserves every track, and classifies human/computer narration only from recording evidence. Missing evidence remains unclassified.

The worker reads `{ "siteUrl", "siteBearer" }` from hidden standard input and derives the pipeline credential; a dedicated `pipelineToken` can be supplied instead. Schedule it hourly. It can be interrupted safely because D1 owns leases and R2 objects are content-addressed. Never schedule overlapping workers with more capacity than the upstream mirror permits.

Audio manifests require the exact public-domain rights statement, Gutenberg URLs, and every track. Downloads are resumable and byte-range checked; uploads require SHA-256. A changed recording or EPUB gets a new immutable identity. Removed rights retire the edition. A refresh cannot silently reuse a map for different bytes.

## Privacy, reviews and moderation

New reviews/shelves are private until their owner explicitly publishes. Public refers to the site's current audience; deployment does not expand that audience. Each authenticated person owns their profile, library, reviews, shelves and stats. Private reviews are absent from feeds, averages, public search and heart/report endpoints. Imported EPUBs cannot be published in a public shelf or public review.

Readers report a review from its menu. Operators use the bearer-protected `GET /api/fore/admin/reports` and `PATCH /api/fore/admin/reports` with `{ "id": "review-id", "moderation": "hidden" }` (or `visible`). Moderation affects public display and aggregates, preserving the owner's record. There is no operator dashboard yet.

`GET /api/fore/export` exports only the authenticated reader's data. API responses use `no-store`; the service worker never caches `/api/` or authentication responses. Explicit offline books/audio are stored in IndexedDB; device bookmarks and queued reading sessions are owner-scoped. Browser storage may be evicted. Use Downloads to remove media and clear site data when leaving a shared device.

## Measurement contract

Stats use UTC boundaries and the selected date window. Reading pace is estimated from visible text ranges and active reading seconds; a hidden tab and a reading tab idle for 90 seconds stop contributing. A two-second dwell prevents immediate page flips counting as read. Replayed cumulative session uploads use maxima, so reconnects do not double count. Audio uses active playback time rather than narration length or word estimates.

A completion is recorded on a transition into Finished; re-reading can produce another completion after leaving that status. Book metrics are calculated from the EPUB spine and scoped to the reader. English Flesch–Kincaid grade estimates use a syllable heuristic, may include front/back matter, and are not an assessed reader ability. Other languages show no grade estimate. Genres and subgenres are Gutenberg shelves and subject headings, not a normalized editorial taxonomy. Vocabulary reflects saved lookups, not an inference that the user failed to understand every saved word.

## Verification in this update

- TypeScript check and production build.
- In-process service checks for authentication, ownership, annotations, definitions and persistence.
- 75 store assertions covering privacy, half-stars, reactions, moderation, shelves, session replay, stats isolation, rights, audio ranges, playback conflicts and alignment integrity.
- ZIP validation with CRC checks, original byte preservation, UTF-8 filenames, streamed/fallback downloads and cancellation.
- Browser inspection confirms the eBook-only Bookstore, separate Audiobooks navigation, voice filters, real catalog search, native audio buffering/playback, checked-map badges, and account dialog behavior.
- Biosync unit checks cover word handoff, CFI ordering, and exclusion of introductions and unmatched gaps. Auth checks cover email syntax, mandatory provider confirmation, and fail-closed configuration.

Before a broad public launch, exercise full authenticated multi-device flows on the deployed host and offline/background playback on mobile Safari/Chrome. Native operating systems may suspend web audio; this is a web app, not a native background-audio service.

## Sources

- [Gutenberg automated access guidance](https://www.gutenberg.org/policy/robot_access.html)
- [Gutenberg mirroring](https://www.gutenberg.org/help/mirroring.html) and [official mirrors](https://www.gutenberg.org/MIRRORS.ALL)
- [Pride and Prejudice recording and rights](https://www.gutenberg.org/ebooks/20686)
- [Original track index](https://www.gutenberg.org/files/20686/20686-index.html)
- [R2 checksum options](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2putoptions)

## Stripe commerce checkout

Cove's commercial checkout uses Stripe PaymentIntents + the Stripe Payment Element while Cove remains the authoritative system of record for carts, quotes, orders, entitlements, promotions, gift cards/store credit, refunds, disputes, tax records, and the accounting ledger.

Required server configuration:

| Variable | Purpose |
| --- | --- |
| `STRIPE_PUBLISHABLE_KEY` | Browser-safe Stripe publishable key. The checked-in example uses Cove's supplied live publishable key. |
| `STRIPE_SECRET_KEY` | **Server only.** Replace `sk_live_REPLACE_WITH_YOUR_SECRET_KEY` in your deployment secret store. Checkout fails closed while this is a placeholder. |
| `STRIPE_WEBHOOK_SECRET` | **Server only.** Signing secret for the Stripe webhook endpoint. |
| `STRIPE_LIVEMODE` | `true` for the supplied live publishable key. Cove rejects signed webhook events whose `livemode` does not match and refuses a secret key from the opposite mode. |
| `STRIPE_TAX_ENABLED` | Defaults to `true`. Uses Stripe Tax calculations with the eBook tax code stored on each offer (`txcd_10302000` by default). |
| `STRIPE_CAPTURE_METHOD` | `automatic_async` (default), `automatic`, or `manual`. Manual mode creates an authorization that a finance operator must capture. |
| `STRIPE_MINIMUM_CHARGE_MINOR` | Minimum remainder Cove will send to Stripe after gift cards/store credit. Defaults to `50`; adjust for currencies/payment-method policy if needed. |
| Finance staff access | Provision `finance_operator` or explicit finance permissions; shared finance bearer tokens are disabled. |

Configure a Stripe webhook to POST to:

`https://YOUR_FORE_HOST/api/fore/stripe/webhook`

Subscribe at minimum to:

- `payment_intent.succeeded`
- `payment_intent.amount_capturable_updated`
- `payment_intent.processing`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `charge.succeeded`
- `refund.created`
- `refund.updated`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`

The endpoint validates Stripe's timestamped HMAC signature, deduplicates by Stripe event ID, checks live/test mode, and records processing status. Do not put the webhook signing secret or Stripe secret key in any `VITE_` variable.

### Payment lifecycle and accounting

1. Cart prices and territorial rights are revalidated server-side.
2. Cove creates an expiring checkout quote and calculates tax from the billing address using Stripe Tax.
3. Promotions, gift cards, and store credit are reserved atomically before payment starts.
4. Cove creates one local order and one Stripe PaymentIntent for the remaining Stripe tender. Both paths use idempotency keys.
5. The browser mounts Stripe's Payment Element using only the PaymentIntent client secret and publishable key. Raw card data never crosses Cove's server.
6. A verified webhook (or reconciliation repair) finalizes payment, consumes internal tender, grants purchase entitlements, preserves preview CFI handoff, and writes immutable ledger entries.
7. Refunds can be partial and mixed-tender: Stripe is refunded through Stripe and Cove restores the corresponding gift-card/store-credit portions. Stripe Tax transactions are reversed with the refund.
8. Dispute/chargeback webhooks populate the finance queue and update order/entitlement state.
9. `/staff/storefront` → **Commerce** exposes finance operations only to authorized finance staff identities with MFA.
10. Accounting CSV exports are generated from the append-only Cove ledger, not reconstructed from mutable order rows.

Run reconciliation regularly (and after webhook incidents). The reconciliation endpoint compares recent Cove orders with Stripe PaymentIntents, repairs paid state when safe, expires abandoned recoverable checkouts, backfills receipt/charge information, records Stripe processor fees from balance transactions, and surfaces any non-zero order subledger balance in the finance console. For unattended reconciliation, use a dedicated machine workflow with a narrowly scoped service-principal endpoint; do not reintroduce a shared finance bearer token. Human reconciliation remains protected by finance RBAC + MFA.

Cove's commerce subledger uses **debit-positive / credit-negative double entry**. Sale, tax, stored-value tender, refund, Stripe-fee, and dispute/chargeback postings are append-only and guarded by a database uniqueness key so webhook or reconciliation retries cannot post the same order/account event twice. Accounting CSV is an operational subledger export; map its account codes to the legal entity's general ledger with your accountant/accounting system.

For development, override both publishable and secret keys with Stripe test-mode keys and set `STRIPE_LIVEMODE=false`. Cove deliberately refuses a `pk_live_…` / `sk_test_…` (or `pk_test_…` / `sk_live_…`) combination. Never exercise the checked-in live publishable key with an unintended real secret during local testing.

If your deployment sets a restrictive Content Security Policy, allow Stripe.js from `https://js.stripe.com` and the Stripe-hosted frames/connections required by the Payment Element. Keep Stripe.js loaded from Stripe rather than copying it into Cove's own static bundle. The same-origin printable invoice route uses a separate locked-down CSP with scripts disabled.

## Pricing / royalties / payouts

Commercial deployments should configure regional pricing deliberately rather than relying on automatic conversion at request time. Use the Commerce & Finance operator panel or its protected `/api/fore/admin/commerce/*` endpoints to load approved FX rates, schedule prices by territory/currency, and create royalty contracts. Pricing decisions are snapshotted into checkout/order history for auditability.

Royalty contracts are versioned and may target a product or edition plus optional territory/format. Contract versions specify the royalty calculation basis (`list_price`, `customer_price`, or `net_revenue`), Cove commission in basis points, payment terms, reserves, and beneficiary splits. Finance parties separately hold payout currency and withholding rate. Do not change historical contract versions after sales have accrued; create a new effective version/contract instead.

Payout workflow is `draft → approved → processing/paid`. Building a batch does not send money. Approval freezes the selected matured royalty events into payable state. Record settlement only after the bank/payment provider confirms the transfer, and supply its immutable external payout ID. Refunds or chargebacks received after a prior payout become negative royalty events and offset subsequent creator settlements rather than rewriting an already-issued statement.

### Rights operations (migrations 0014–0016)

Rights are evaluated using edition + territory + format + sales channel + effective date. A missing grant denies availability, explicit active deny rows override allow rows, and DRM requirements are checked against the current delivered asset. Retail rights do not imply subscription/library permission and eBook rights do not imply audiobook rights. Retail, subscription and library availability now share the same fail-closed channel projection. The retail catalog, taxonomy counts, CMS placements, recommendations and external-search index use its retail slice; subscription/library filters and customer-visible channel badges use their own territorial slices. Stale Meilisearch rights metadata causes a D1 fallback rather than a leak.

On Cloudflare, storefront territory comes from `CF-IPCountry`. `FORE_DEFAULT_TERRITORY` is only a deployment/local fallback when that trusted edge signal is absent. Customer query parameters cannot override it. Checkout independently binds the rights territory to `billingAddress.country`, the same country sent to Stripe Tax. Every pricing/checkout rights evaluation can be audited in `rights_decisions`, and every purchased line snapshots its grant, rightsholder, license, DRM and promotion constraints.

The Commerce operator console exposes rightsholder registration, named/nested territory sets, contract language rules, distribution grants, `WORLD`/named-set/direct/historical scope expressions with exclusions, status/allow/deny controls, exclusivity, channel and format selection, effective dates, DRM, subscription/library flags, promotion restrictions, resolved-market previews, overlap/conflict review, and a live decision tester. Saving a grant snapshots its exact resolved countries; later edits to a reusable territory set do not alter that executed scope. Legal-rights changes are privileged staff operations and are recorded through the staff/audit system.

Historical successor mappings are an operational aid, not a legal conclusion that rights automatically transferred to every successor state. Contracts that refer to former or disputed territories still require publisher/legal review. Likewise, the seeded ISO registry means Cove can *represent and enforce* rights for global storefront markets; it does not assert that a title is licensed in all of them. No matching active grant remains a denial.

## Cove Publishing

Publishing validation/release workers use a scoped service-principal credential issued from the staff control plane and stored only in the worker secret manager as `FORE_SERVICE_TOKEN`. `FORE_STAFF_BOOTSTRAP_TOKEN` is a separate break-glass secret used only to provision the first/administrative staff principal; rotate and restrict it aggressively. Routine publishing review and moderation use the signed-in staff identity with SSO binding, MFA/AAL2 enforcement and granular RBAC and do **not** accept a shared publishing-admin bearer token. `FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK` is optional and should remain `false` when every submission requires human review.

Creator assets are uploaded to private quarantine object storage first. External workers must have privileged object-storage access and should lease jobs from `/api/fore/publishing-worker/jobs/lease`, run the named validator, then complete the lease through `/api/fore/publishing-worker/jobs/complete`. Required malware, official EPUBCheck, rendering and device-compatibility jobs are fail-closed. Do not enable creator publication by manually bypassing those jobs.

Connect KYC, tax and payout providers through deployment-specific adapters. Cove's core schema intentionally stores only provider references, statuses, withholding/requirements, payout method/currency and masked account data. Raw identity documents, raw tax IDs/forms and raw bank credentials should remain with the specialized provider. Full architecture and integration rules are in `docs/PUBLISHING.md`.

### Creator commerce workers

For Cove Publishing marketplace operation, schedule the authenticated publishing worker to call `/api/fore/publishing-worker/preorders/tick` frequently enough to open/lock/release preorder plans at their configured times, `/api/fore/publishing-worker/preorders/refunds` to execute queued lowest-price/cancellation/failure refunds, and `/api/fore/publishing-worker/promotions/tick` to start/end approved campaigns. These jobs are idempotent/lease-aware where external payment work is involved. Keep the existing release validation, rights, notification, Stripe reconciliation, payout, and statement jobs in operation as well. Charge-at-release preorders intentionally remain disabled until a production payment-method vault/mandate provider is configured.

## Retail-intelligence workers

For commercial discovery, schedule the following authenticated publishing-worker operations after applying migrations through `0029_retail_intelligence_hardening.sql`:

- `POST /api/fore/publishing-worker/authors/alerts/tick` at least every 15 minutes to detect publication/preorder events and fan out idempotent in-app author alerts.
- `POST /api/fore/publishing-worker/analytics/metrics` hourly to rebuild the bounded daily Cove retail aggregates. The hardened aggregate uses event eligibility/weights and unique actors rather than trusting raw repeated client clicks.
- `POST /api/fore/publishing-worker/analytics/rankings` hourly per supported storefront territory to create immutable chart snapshots under the current versioned ranking policy.
- continuously lease `/api/fore/publishing-worker/analytics/outbox/lease` and acknowledge with `/api/fore/publishing-worker/analytics/outbox/complete` from the warehouse exporter. Warehouse storage/retention is an external deployment concern; do not redirect reader-personal-state tables into this stream.

Review-integrity thresholds are stored in immutable `review_integrity_policy_versions`. Trust & Safety can create a new policy through the staff-only `POST /api/fore/admin/moderation/review-integrity-policy` route; never edit an old policy row in place. Author profile/social links are public HTTPS only, and platform-labeled links are validated against their official host before submission.

### SEO, accessibility, and EPUB capability operations (migration 0030)

Apply `0030_seo_accessibility_and_format_support.sql` after `0029`. Set `FORE_PUBLIC_URL` to the canonical public origin before production indexing; `/robots.txt`, `/sitemap.xml`, and SSR route canonical metadata derive from that trusted server-side origin. The migration stores immutable publishing EPUB inspections plus edition accessibility/format profiles, exact-asset publisher declarations, immutable audit evidence, and creates `fore-epub-accessibility-v1` as the active validation/disclosure policy.

External publishing workers still need EPUBCheck, render, and device-compatibility services. Inline inspection is deliberately fail-closed for malformed archives/navigation, executable EPUB scripting, and remote resource dependencies, and verifies accessibility discoverability/structure signals without pretending that detected MathML or metadata alone proves assistive-technology compatibility. Record automated/manual WCAG audits with the staff-protected `/api/fore/admin/accessibility/audit` endpoint and retain full reports in private object storage with the report SHA-256 in D1. See `docs/SEO_ACCESSIBILITY_FORMATS.md`.


## Traditional publisher B2B ingestion

Apply migration `0033_traditional_publishing_contracts_work_editions.sql`. Configure a server-only `FORE_PARTNER_WEBHOOK_MASTER_SECRET` (32+ random bytes) before enabling callback delivery. Schedule authenticated publishing-worker calls to `/api/fore/publishing-worker/partner-feeds/tick` and `/api/fore/publishing-worker/partner-acknowledgements/tick`; also run `/work-identities/tick` and `/work-reconciliation/tick` as catalog maintenance.

API partners authenticate with environment-scoped Cove partner credentials. SFTP/object-drop integrations should terminate in a hardened transfer gateway that resolves the channel's `secret_reference` from your secret manager and submits bytes through the same partner API with `X-Cove-Channel-Id`, rather than placing SSH passwords/private keys in D1. Configure gateway malware scanning, host-key verification, source allowlists, object retention, and idempotent handoff.

Production certification must remain a Cove staff action and requires an assigned contract with an effective active contract version. Callback endpoints must be public HTTPS; enforce outbound DNS/egress controls in production in addition to Cove's URL/redirect checks. Full protocol, payload, contract, and public-domain edition rules are in `docs/TRADITIONAL_PUBLISHING_CONTRACTS.md`.

## Fraud, risk, and tax compliance (migration 0034)

Fraud is now a first-class platform domain. Versioned buyer, publisher, community, usage and payout risk
policies write immutable assessments, explicit holds and investigator cases. Checkout, secure EPUB
fulfillment, commercial audiobook playback/offline licenses, publisher approval, subscription royalties
and payout release all consume these decisions rather than relying on a single processor risk score.
Use the staff publishing operations console for the investigation queue and hold handling. A payout hold
is re-assessed before release and cannot override an unresolved fraud/tax/rights condition.

Customer tax remains processor/provider driven: with `STRIPE_TAX_ENABLED=true`, checkout uses Stripe Tax,
while Cove records immutable calculation/transaction/reversal evidence and registration/reconciliation
state for accounting operations. Schedule `/api/fore/admin/tax/reconcile` regularly in addition to normal
commerce reconciliation.

Publisher/payee tax is a separate provider-adapter workflow. Configure `FORE_TAX_WEBHOOK_SECRET` with at
least 32 random bytes and have the tax provider adapter sign `${timestamp}.${raw_body}` with HMAC-SHA256,
using `x-fore-tax-timestamp` and `x-fore-tax-signature: v1=<hex>`. Cove stores provider references, status,
last four TIN digits and normalized compliance state only—never full TINs or tax-form images. Royalties
for an unverified publisher are held from payout; effective withholding comes from verified profile state
plus finance-managed, effective-dated withholding/treaty rules. Load statutory rates from your specialist
provider/tax adviser rather than encoding them in application logic. See `docs/RISK_TAX_COMPLIANCE.md`.

## Global storefront, staff identity, and production operations (migration 0035)

Apply `0035_global_storefront_staff_ops_observability.sql` to enable country/locale/currency storefront policy, versioned UI translations, RTL direction, localized taxonomy, regional payment-method policy, service principals, telemetry/SLO/incident records, generic queues/DLQs, recovery evidence, deployment records, synthetics, and capacity evidence.

Do not restore the retired shared operator tokens. Human operators must authenticate as Cove accounts mapped to `staff_principals`; grant the narrow staff role needed for catalog review, community moderation, publisher support, finance/tax, fraud, storefront localization, or operations. Require MFA/AAL2 for privileged work and keep `super_admin`/the bootstrap token for break-glass use only. Workload processes receive separate scoped service-principal credentials via `/api/fore/admin/service-principals/credential`; the plaintext credential is returned once and belongs only in that workload's secret manager.

Configure `FORE_PUBLIC_URL` for edge/CDN probes and optionally `FORE_ALERT_WEBHOOK_URL` / `FORE_ALERT_WEBHOOK_TOKEN` plus `FORE_ERROR_REPORTING_URL` / `FORE_ERROR_REPORTING_TOKEN`. External telemetry destinations must be HTTPS and should be egress-allowlisted by the deployment platform. Schedule the operations service principal to execute dependency checks, SLO refresh, synthetic checks, alert delivery, and queue workers. Do not mark a backup verified without provider evidence, and do not accept a restore drill as passing unless the isolated restore proves integrity/application health and measured recovery fits the registered RPO/RTO. Register a migration control before a production release lists that migration, and use blue/green/canary rollout with an explicit rollback plan. See `docs/GLOBAL_STOREFRONTS_STAFF_OPERATIONS.md` and `docs/PRODUCTION_OPERATIONS.md`.

## Security-program deployment requirements

Configure `FORE_ENVIRONMENT`, `FORE_SECURITY_CONTACT_EMAIL`, and `FORE_SECURITY_POLICY_URL`; optionally configure a credential-free `FORE_CSP_REPORT_URI`. Production must sit behind a managed DDoS/WAF/bot-management provider and record verification evidence through the security control plane. Do not treat application rate limits as a WAF substitute.

Run `npm run security:secret-scan`, `npm audit --audit-level=high`, lint/typecheck, `npm run test:security-sync`, build, and `npm run security:sbom` in CI. The included GitHub Actions workflow also produces build-provenance attestations for main. Ingest scanner/SBOM/provenance results with a machine principal scoped to `security.evidence.write`.

Use an external header probe against the deployed origin and POST the observed CSP/HSTS/Permissions-Policy/Referrer-Policy/COOP/CORP values to `/machine/v1/security/headers`; source configuration by itself is not deployment verification. See `docs/SECURITY_PROGRAM.md`.

Reader clients should register a sync client and use optimistic entity versions. On HTTP 409, pull/inspect the server value or use the conflict-resolution endpoint rather than blindly retrying. See `docs/CROSS_DEVICE_SYNC.md`.

## Social-reading operations

No new third-party social provider is required. Social APIs use Cove sessions, RBAC/MFA, notifications, moderation, and D1. Schedule the existing publishing worker identity to call `POST /api/fore/publishing-worker/authors/social/tick` regularly so verified-author posts fan out to followers in leased batches. Monitor failed `author_social_fanout_jobs`, notification DLQs, moderation cases, and `social_integrity_signals`. Reader Social Reading is intentionally disabled by default and private notes are never published unless `share_note` is explicitly enabled for a shared highlight.
