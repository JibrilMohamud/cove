# Cove Retail Intelligence

Cove's commercial discovery stack separates **operational retailer telemetry** from **reader-facing personal reading statistics**. Retail events are append-only commercial facts used for merchandising, fraud detection, creator aggregate reporting, and warehouse export. Reading-state UX remains in its existing reader-domain tables and is not exposed through this operational event API.

## Canonical retail events

The `retail_events` stream accepts a deliberately bounded vocabulary: `search_performed`, `search_result_clicked`, `product_viewed`, `sample_started`, `sample_completed`, `wishlist_added`, `wishlist_removed`, `cart_added`, `cart_removed`, `checkout_started`, `purchase_completed`, `refund_completed`, `book_opened`, `book_finished`, `review_submitted`, `review_hearted`, `promotion_impression`, and `promotion_clicked`.

Server-authoritative money events (purchase/refund) are emitted only by commerce after the corresponding order/refund state is committed. Client events use dedupe keys and rate limits. Every accepted event creates a durable `retail_event_outbox` row for warehouse delivery; workers lease rows with expirations, retry with backoff, and dead-letter after repeated failure.

### Ranking eligibility and anti-gaming

Accepted telemetry is not automatically trusted as a ranking signal. `retail_events` freezes three quality fields at ingestion: `ranking_eligible`, `ranking_weight`, and `quality_reason`. Server/worker facts are authoritative; the only public client-ingest events are search performed, search-result click, and product view. Client events must be recent, target a live Cove product where applicable, carry a query ID for result clicks, and are capped per actor/day/product. Events over those caps remain available to operations/warehouse analysis but receive zero ranking weight.

Daily ranking materialization also computes distinct viewers, clickers, sample readers, wishlisters, buyers, readers, and finishers. Trending conversion and behavioral charts consume those unique-actor measures instead of raw repeat event counts. This does not make fraud impossible, but it sharply reduces the value of refresh loops and session spam while keeping the raw event stream available for abuse research. Retail events and ranking snapshots/entries are append-only database evidence.

Recommended schedules:

- refresh `retail_daily_product_metrics` hourly (90-day rebuilding window by default);
- refresh ranking snapshots hourly by storefront territory;
- continuously lease warehouse outbox batches;
- enqueue/process author release alerts at least every 15 minutes.

## Cove-native charts

Commercial charts never use Project Gutenberg `download_count`. The active row in `retail_ranking_policy_versions` is the source of truth for weights and decay. A ranking snapshot stores the policy version and every entry stores its component values plus policy hash, making historical chart output explainable.

- **Bestselling:** purchase units + log revenue, penalized for refunds, with temporal decay.
- **Trending:** recent purchases, wishlists, completed samples, search-result clicks, conversion rate, and refunds with fast decay.
- **Most read:** opens, completions, and subscription consumption.
- **Most wishlisted:** Cove wishlist additions.
- **Top rated:** Bayesian rating with review provenance and abuse-adjusted trust weights.
- **New & noteworthy:** age-gated blend of trending, rating, and completion signals.

Publishers cannot set or edit chart scores through title metadata or the creator dashboard. Any future editorial boost must remain a separate, auditable merchandising surface rather than mutating behavioral chart inputs.

## Review provenance and integrity

Reviews remain open to readers without a Cove purchase. At first review creation, Cove freezes one provenance snapshot: verified purchase, subscription reader, free promotional copy, gifted copy, publisher/author copy, or sideloaded/unverified. The public UI displays that provenance, while internal trust scores are intentionally not returned to clients.

Automated integrity signals include review velocity/brigades, rating bursts, suspicious account links, duplicate text, promotional relationships, active sanctions, vote velocity, linked-account voting, and reciprocal-heart patterns. Signals may limit/exclude ranking influence, but do not automatically delete a review or prove misconduct. High-risk signals open a staff moderation case. Staff can confirm, mitigate, or dismiss individual signals; notes are append-only and ordinary moderation sanctions/appeals remain the enforcement path.

Thresholds and ranking consequences come from immutable `review_integrity_policy_versions`, not scattered constants. Each generated signal stores the policy version in `model_version`/evidence, so later policy changes do not erase which rules produced an earlier signal. New versions are created through the permission-gated staff API; historical rows remain immutable.

## Commercial author identities

`author_profiles` extends stable catalog contributors rather than creating a second author namespace. Publisher editors can maintain biography, HTTPS portrait URL, policy-controlled links, and optional publisher/imprint association, then submit a profile for verification. Staff verification creates immutable `author_profile_events`. A verified badge means Cove verified the commercial author identity; it is not a quality endorsement.

Author pages derive bibliography, series, and upcoming releases from catalog relationships. Follows share Cove's existing contributor-follow identity and add release/preorder alert preferences. Alert jobs are idempotent and delivered through Cove's durable commerce-notification system.

Profile links are not free-form labels over arbitrary destinations. All links must use public HTTPS URLs; platform-specific link types (Instagram, Facebook, X/Twitter, TikTok, YouTube, Bluesky) must resolve to the corresponding official host. Generic websites and federated Mastodon links remain allowed under the public-network checks. Submitted profile revisions freeze their link snapshot for staff review.

## Privacy and retention

Do not place raw manuscript text, review moderation evidence, payment credentials, email addresses, IP addresses, or unrestricted client payloads in retail-event properties. Warehouse consumers should apply a retention policy, minimize user identifiers, aggregate creator-facing analytics, and maintain deletion/pseudonymization procedures consistent with Cove privacy requirements. Personal reading-stat features should query reader-domain state, not the retailer warehouse.
