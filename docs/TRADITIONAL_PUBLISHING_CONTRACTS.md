# Traditional publisher ingestion, distribution contracts, and Work/Edition policy

Cove's commercial publishing stack separates **partner transport**, **catalog facts**, **contract policy**, **rights grants**, and **customer ownership**. A publisher feed is never itself permission to sell a title. Production application requires a currently assigned, effective, versioned distribution contract and the resulting rights grant remains subject to that contract version.

## Partner organizations and environments

Traditional publishers/distributors use an existing Cove Publishing organization account plus `publisher_partner_profiles`. Partner admins can configure integration settings but cannot self-certify production. Cove staff moves a partner through testing/certification/active status. Sandbox credentials and feed records are isolated from production catalog rows.

API credentials are environment-scoped, individually revocable, optionally IP/CIDR restricted, and stored only as SHA-256 digests. Supported scopes are `feeds:write`, `feeds:read`, `assets:write`, and `catalog:read`. Production credentials cannot be issued until staff certification is active.

SFTP and object-drop are modeled as ingestion channels rather than embedding raw SSH/private-key material in the bookstore database. A hardened transfer gateway should poll/push the configured path, resolve `secret_reference` from the deployment secret manager, and submit the resulting bytes through the same partner API. This keeps ONIX validation, sequencing, idempotency, contract enforcement, acknowledgements, and auditing identical across API/SFTP/object-drop transports.

## Feed API

Authenticated partner endpoints are under `/api/fore/partner/v1`:

- `POST /feeds` — metadata, price, availability, territory, or asset-manifest feed.
- `GET /feeds/:id/ack` — machine-readable submission/item/application state.
- `POST /assets` — one binary EPUB/cover/audio/sample/supplement.
- `POST /assets/batch` — bounded ZIP containing `manifest.json` plus EPUB/cover files.
- `GET /ping` — credential/environment health check.

Required feed headers include `X-Cove-Feed-Type`, `X-Cove-Feed-Format`, and preferably stable `X-Cove-Feed-Id` and monotonically increasing `X-Cove-Feed-Sequence`. Transfer gateways should also send `X-Cove-Channel-Id` using an active channel configured for the same partner/environment; Cove rejects mismatched or disabled channel provenance and persists the channel on the submission audit trail. Full metadata snapshots may opt into explicit missing-record withdrawal with `X-Cove-Full-Feed-Delete-Missing: true`. Retries are idempotent by external feed ID/checksum, and stale sequence numbers fail with a conflict rather than being silently replayed.

Cove accepts ONIX 3.x/2.1 **reference tags** for bibliographic metadata and Cove JSON for all feed types. The in-process ONIX parser rejects external DTD/entity declarations and fails closed on short-tag-only documents rather than guessing semantics. Large partners should send standards-compliant reference-tag ONIX or normalize upstream in their transfer gateway.

A minimal Cove JSON metadata record looks like:

```json
{
  "products": [{
    "productKey": "9780000000001",
    "notificationType": "update",
    "title": "Example Book",
    "format": "ebook",
    "contributors": [{"name":"Example Author","role":"author","position":0}],
    "rightsBasis": "licensed",
    "territories": {"mode":"expression","include":["US","CA"],"exclude":[]},
    "currency": "USD",
    "priceMinor": 1299,
    "availability": "available",
    "drmRequirement": "watermark",
    "contractReference": "ACME-2026"
  }]
}
```

Dedicated delta feeds use the same stable `productKey` and only mutate their owned concern: price, availability, or territory. Metadata does not need to be resent for every commercial change.

## Asset manifests and bulk delivery

Asset-manifest feeds are Cove JSON and can arrive before or after binaries:

```json
{
  "assets": [{
    "productKey": "9780000000001",
    "assetKind": "epub",
    "filename": "9780000000001.epub",
    "sha256": "<64 lowercase/uppercase hex chars>",
    "sizeBytes": 4281943,
    "mimeType": "application/epub+zip"
  }]
}
```

Cove persists each expected checksum/size/MIME tuple in `publisher_asset_expectations`. Binary upload reconciliation is checksum-first; filenames are not integrity evidence. A matching upload becomes accepted/linked, while checksum/size/MIME disagreements stay visible as mismatches in the partner dashboard.

Bulk ZIP uploads require a root `manifest.json`, CRC verification, bounded compressed/expanded sizes, path traversal rejection, duplicate product/kind rejection, and per-file publishing limits. Production binaries pass through the same quarantine/validation storage path as normal Cove Publishing uploads; sandbox binaries remain isolated.

## Automated acknowledgements

Every submission receives durable receipt, validation, and application response rows. Partners may poll `/feeds/:id/ack` or configure an HTTPS acknowledgement callback URL. The delivery worker endpoint is `/api/fore/publishing-worker/partner-acknowledgements/tick` and should run continuously/frequently alongside `/partner-feeds/tick`.

Callbacks are idempotent (`Idempotency-Key`/`X-Cove-Event-Id`) and signed with HMAC-SHA256. Cove sends:

- `X-Cove-Timestamp: <unix seconds>`
- `X-Cove-Signature: v1=<base64url HMAC>`

The signed input is exactly `timestamp + "." + raw_request_body`. Publisher admins with MFA can retrieve their account-specific verification secret from the dashboard. It is derived from the server-only `FORE_PARTNER_WEBHOOK_MASTER_SECRET`; the master secret is never returned. Configure at least 32 random bytes of secret material and rotate it under an explicit partner migration plan because changing it changes all derived partner secrets.

Callback destinations must be HTTPS and cannot use embedded credentials, localhost, or literal private/link-local addresses. Redirects are refused. Production deployments should additionally enforce DNS/egress policy in the Worker/network layer to protect against DNS rebinding and newly-resolved private targets.

Failed callbacks retry with bounded exponential backoff and keep payload hashes, attempt timestamps, destination, error text, and partner audit records. A partner that adds a callback later automatically requeues prior `not_configured` responses.

## Distribution contracts

`rights_contracts` identifies the commercial relationship; `rights_contract_versions` contains immutable legal/economic policy. A version tracks:

- effective window and retailer commission;
- payment schedule/minimum payout rules;
- returns terms;
- subscription terms;
- marketing permissions;
- DRM requirements;
- delivery rules;
- termination policy;
- post-termination customer-access policy;
- exact territory decisions;
- allowed formats with DRM/download/device/offline controls;
- retail/subscription/library channel permissions;
- source-document object reference and SHA-256.

Activated terms and their territory/format/channel children are database-immutable. To change terms, create a new version. Activating a later version closes/supersedes the prior active window without rewriting its terms. Publisher organizations are assigned to contracts separately, with their own start/end/status window.

Production metadata/territory application requires a currently assigned contract and an effective active version. Contract scope is enforced before a draft can become sellable. The selected contract version is then carried into rights grants/decisions, publication manifests, commerce ownership snapshots, royalty economics, and secure delivery policy. Book flags cannot broaden a contract.

Post-termination customer access is explicitly one of `preserve_perpetual_purchases`, `preserve_downloaded_only`, `block_future_downloads`, or `revoke_all`. Permanent-purchase delivery uses the acquisition-time policy snapshot where appropriate; temporary subscription/loan access continues to require current rights.

## Canonical Work and differentiated Editions

Cove models the intellectual **Work** separately from specific **Editions**. A Work page can contain the canonical free Gutenberg edition alongside annotated, translated, illustrated, scholarly, audiobook, and original commercial editions.

`work_identity_keys` provides stable external-work-reference and normalized title/author/language identities. `work_redirects` lets reconciliation merge accidental duplicate Work records without breaking old links. Gutenberg is preferred as the canonical free public-domain source when reconciling equivalent public-domain Works.

The active public-domain policy `fore-public-domain-editions-v1` reserves `canonical_public_domain` for Cove's canonical free-source ingestion. Commercial public-domain submissions must declare a substantive distinction (`annotated`, `new_translation`, `illustrated`, `scholarly`, or `commercial_audiobook`) plus a differentiation summary; new translations require a translator. Exact identical EPUB hashes can be rejected/reviewed as undifferentiated duplicates.

This prevents a storefront full of interchangeable copies while still allowing meaningful editions to compete under one Work page.

## Required operations

Before production partner activation:

1. create/verify the publishing organization and staff-approved partner profile;
2. create and assign a distribution contract with an effective active version;
3. exercise metadata/delta/asset flows in sandbox and validate acknowledgements;
4. certify the partner and issue production credentials;
5. schedule feed-application, acknowledgement-delivery, work-identity, and Work-reconciliation workers;
6. configure private object storage, secret management, monitoring, dead-letter/retry alerts, and transfer-gateway egress restrictions;
7. retain contract source documents and legal approvals according to the operator's records policy.

The application deliberately does not store SFTP passwords/private keys, raw contract documents in public storage, or permanent commercial asset URLs in catalog metadata.
