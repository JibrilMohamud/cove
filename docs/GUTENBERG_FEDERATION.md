# Federated Gutenberg public-domain ingestion

Cove treats each Gutenberg-family project as a separate legal/catalog source. A source record is **not** a worldwide license. Availability is created only after an item has passed source-specific rights and asset verification and an exact territory grant has been written into Cove's commercial rights engine.

## Storefront mapping

| Source | Cove source ID | Default legal scope | Ingestion behavior |
| --- | --- | --- | --- |
| Project Gutenberg (US) | `pg_us` | `US` | Existing Gutendex/public-domain pipeline. US evidence never expands to another country. |
| Project Gutenberg Canada | `pg_ca` | `CA` | Complete Canadian catalogue is staged. Native PGC EPUB is preferred; PGC-hosted HTML-only editions are normalized into Cove-owned EPUBs before activation. |
| Project Gutenberg Australia | `pg_au` | `AU` | Current A–M and N–Z author catalogues are fetched in parallel. Native PGA EPUB is preferred; trusted PGA HTML is normalized when no EPUB exists. External linked libraries are not inherited as PGA rights. |
| Project Gutenberg Europe / reviewed European material | `pg_eu` | none | **No blanket EU/Europe grant.** Each reviewed manifest item must state exact ISO country codes and evidence. Native EPUB or trusted HTML may be normalized. |

A Canadian customer can therefore receive an edition with an approved `CA` grant while the same edition remains unavailable in the US, Australia, UK, France, etc. An Australian item behaves the same way for `AU`. European material is exact-country scoped: an item evidenced for `FR` and `DE` does not become available in `ES`, `IT`, `GB`, or any other market unless those countries are explicitly present in the reviewed evidence.

## Why Europe is country-scoped

Project Gutenberg Europe was conceived around multiple European copyright laws and national/linguistic branches rather than one universal European public-domain determination. Cove therefore refuses to translate “Project Gutenberg Europe” into `EU = allowed`. This is deliberate fail-closed behavior. Configure a reviewed country-scoped manifest if European material is to be distributed.

Example manifest:

```json
{
  "version": "2026-09-24",
  "items": [
    {
      "id": "example-work-1",
      "title": "Example Work",
      "authors": [{ "name": "Example Author" }],
      "languages": ["fr"],
      "epubUrl": "https://your-reviewed-source.example/example.epub",
      "htmlUrl": "https://your-reviewed-source.example/example.html",
      "sourceUrl": "https://your-reviewed-source.example/example",
      "rightsStatus": "public-domain",
      "territories": ["FR", "BE"],
      "rightsEvidenceUrl": "https://your-reviewed-source.example/evidence/example",
      "rightsEvidenceDigest": "sha256:..."
    }
  ]
}
```

Each item needs at least one of `epubUrl` or `htmlUrl`; EPUB wins when both exist. The manifest URL and every asset/evidence URL must use HTTPS and an allowlisted origin. Configure `FORE_GUTENBERG_EUROPE_FEED_URL` and `FORE_GUTENBERG_EUROPE_TRUSTED_ORIGINS` on the server. Without an approved country-scoped feed, `pg_eu` remains degraded and publishes nothing rather than guessing.

## Commercial ingestion flow

1. **Source registry and independent health state.** Each source has its own refresh cadence, priority, cursor, lease, retry/backoff state, catalog snapshot hash and ingestion audit records.
2. **Bounded catalog staging.** Catalog snapshots are processed in bounded batches. Large sources resume from a cursor. If a snapshot changes during a multi-run cycle, Cove restarts the cycle so an offset is never applied to different catalog bytes.
3. **Snapshot de-duplication.** Single-document feeds use ETag/Last-Modified when possible. Multi-document feeds such as PGA use a combined SHA-256 snapshot hash to avoid re-writing thousands of unchanged rows.
4. **Pending by default.** A newly discovered or materially changed item is not sellable/readable. Rights and commercial-use state return to `pending` and previous source-derived grants are suspended.
5. **Trusted HTTPS asset fetch.** Each adapter has a strict host allowlist. External links present in source catalog pages are not silently accepted as though they belonged to that source.
6. **Canonical asset production.** Cove prefers a source EPUB. Regional EPUBs are ZIP/CRC validated, inspected for copyright/permission exceptions, stripped of source branding/proprietary headers/covers where commercial redistribution requires that, normalized, and hashed. When a trusted source exposes only HTML, Cove removes executable/non-book markup and source legal/trademark blocks, converts the readable text into a deterministic EPUB3 split into bounded spine documents, validates the generated archive, and hashes it. Devices therefore always receive one Cove EPUB contract regardless of upstream format.
7. **Quarantine on ambiguity.** Permission-only/copyright notices, residual licence/trademark boilerplate, remaining protected source branding, untrusted URLs, malformed EPUB/HTML or other legal-integrity failures quarantine the item. There is no customer fallback to the raw upstream file.
8. **Append-only evidence.** Successful verification writes `gutenberg_rights_evidence` per exact territory. Evidence is append-only and is referenced by the source cache, the resulting `rights_grant`, runtime `rights_decision`, and purchased order-line rights snapshot.
9. **Fail-closed grant activation.** Database triggers reject Gutenberg public-domain grants without matching approved source evidence. A Canadian evidence row cannot authorize a US grant; an Australian row cannot authorize New Zealand; European evidence authorizes only its enumerated countries.
10. **Canonical delivery.** Regional customer delivery is Cove-cache-only. If the verified canonical object is absent, Cove returns unavailable/temporary failure instead of downloading the upstream source on the customer request.
11. **Source retraction handling.** Items absent from a complete later source snapshot are marked stale, products/offers are disabled and source-derived rights grants are suspended. The stored canonical object/evidence remains for audit.

## Scaling characteristics

- Per-source leases prevent overlapping harvesters.
- Resumable cursors bound D1 work on large catalogs.
- Catalog batches are grouped into database batches rather than one network/database transaction per title.
- Asset processing uses a fair-share queue partitioned by source so one 5,000-title regional backlog cannot starve another source.
- Native EPUB is preferred, while HTML fallback conversion happens asynchronously in the same bounded worker path rather than on a customer request.
- Asset writes are content-hashed and stored in Cove-controlled object storage; object metadata records both source format and canonicalizer version.
- Source health, ingestion runs, accepted/quarantined counts and errors are persisted for operations.
- Search only sees normalized active products; territorial filtering still runs through the same rights projection used by checkout.

## Operational/legal boundary

The federation automates enforcement of evidence supplied by the source or reviewed manifest; it is not a copyright-law inference engine. Project-specific public-domain determinations remain jurisdictional. Do not add a country to an item's grant merely because another country has a similar copyright term. Translation rights, posthumous publication, restorations, special national rules and permission-only editions can make apparently similar works differ legally.
