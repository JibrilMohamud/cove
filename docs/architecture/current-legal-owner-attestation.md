# Current legal baseline: private owner handoff

This is a non-authorizing offline verifier. It does not create a production owner epoch or independently capture live database state. The trusted operator must obtain a consistent complete canonical discovery and current inventory from the reviewed owner, reconcile unresolved grants, and pin the discovery hash, actual primary identity, epoch and independently provisioned owner public key outside the evidence archive. The owner signs the UTF-8 lowercase hex SHA-256 returned by hashCurrentBaseline(payload) using ECDSA P-256 with SHA-256; the signature is DER/base64url. Payload fields are schema, issuer, primaryId, ownerEpoch, discoverySha256, inventorySha256, observedAtMs and validUntilMs. The schema is cove.owner-inventory-attestation.v1. No signing key belongs in the repo or CI. The independent reviewer must use a separate pinned key and issuer and sign the existing review envelope after owner observation. Unknown products without recorded scopes are explicitly quarantined; any unresolved grant blocks compilation. The validity window is capped at fifteen minutes for the owner attestation. This is not approval to issue rights.

Private interactive CLI (inputs and output outside the repo):

`node scripts/release/compile-current-legal-baseline.local.mjs inventory.json review.json reviewer-trust.json epoch.json discovery.json owner-attestation.json owner-trust.json candidate.json`

OwnerTrust includes issuer, primaryId, ownerEpoch, discoverySha256, publicKeyPem and spkiSha256. Never self-attest an unverified production snapshot or fabricate legal evidence. Production consumer wiring and a genuinely current signed owner inventory and independent rights review remain separate gates.
