# Partner feed application owner migration — 2026-10-30

## Verifiable source retirement

Exactly **25 owner-command-required** SQL mutations and **one nonauthorizing acknowledgement** in `traditional-publishing.server.ts` have been physically removed from the shared `processPartnerFeedQueue` application family and transplanted under the private `CoveLegalAuthority` Durable Object. The original partner-upload asset expectation writer remains in the shared module and is still owner-required. Other partner intake, credentials, contract-assignment, identity-reconciliation and publishing trust writers remain unresolved. Independently compare the old and new source snippets, function membership, and exact SQL digests; the canonical review remains source-bound with releaseApproval=false. Overall owner-required decreases **306 → 281** and traditional-publishing **38 → 13**.

## Execution safety

The old public/scheduled entry point now sends only a strict typed `partner.process-feed` RPC over the pre-existing staged legal owner binding. No caller-provided SQL, submission ID, legal evidence or product identity can select a row. An unenrolled/disabled owner throws 503 before any canonical write. The owner requires its 15-minute-or-less synthetic-QA lease, exact private bearer, fixed route and body schema, verifies the resulting bounded receipt and prevents concurrent invocations of the queue in one Durable Object instance. The code remains entirely under the existing private owner codepath rather than moving the scanner's ignored source list.

**Positive production product/offer/grant application is intentionally NOT activated.** The private queue selects only `environment='sandbox'` and non-asset-manifest feeds, and independently rejects any unexpected production/asset-manifest row before its application. It marks simulated sandbox items as previews; no positive partner publication or customer delivery is certified. The full historical application implementation is preserved in the private owner for later owner-epoch and contract-version integration, but is unreachable for positive releases until those authorizations are independently added. Shared partner upload and unrelated functions remain subject to their original audit disposition.

## Required certification and rollback

Before activating production: acquire durable deny-first product/version and jurisdiction holds, independently verify source rights, publisher principal, versioned contract/territory and bytes, atomically publish legal access only after canonical commit, exercise interruption/replay and marketplace withdrawal, retire direct D1 bindings including cron/admin/old deploys, test Stripe-to-media refund/withdrawal and rehearse protected Cloudflare-to-Vercel rollback. Rolling back after any real owner command may not reinstate shared direct SQL; leave owner disabled and reconcile operation receipts first. This change neither activates production secret nor modifies public DNS.
