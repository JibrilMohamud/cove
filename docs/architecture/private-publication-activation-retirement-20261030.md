# Publication activation and preorder direct writer retirement

**Review:** October 30, 2026. **Scope:** 18 reviewed owner-required SQL sites in `src/features/fore/publishing.server.ts`:

- 8 `publishing.activatePublicationCommercialTerms` rows covering offers, contracts, royalty contracts, and rights grants;
- 5 `publication.activate-version` rows covering editions, assets, products, lifecycle state and activation history;
- 4 `publishing.advancePublishingReleaseSchedules` rows in `openPublicationPreorderOwned` covering scheduled releases and preorder activation;
- 1 `publishing.syncCatalogAccessibility` row for accessibility layout syncing, moved with the only remaining activation consumer.

## Source and execution boundary
The complete source bodies are relocated without SQL reclassification to non-exported functions physically inside `CoveLegalAuthority`. The existing owner activation route invokes its private function after independently loading a frozen publication and applying the owner publication command hold; the preorder owner executor receives an internal private callback instead of importing the API-accessible function. The owner-private materialization path also resolves commercial terms locally. Legacy `activatePublicationCommercialTerms`, `activatePublicationVersionOwned`, and `openPublicationPreorderOwned` exports remain present **only as 503 fail-closed stubs** so no external caller silently gets raw canonical D1 write access. The normal scheduler must use the typed owner's bound facade; unenrolled scheduled release and rollback are deliberately blocked, not marked successful.

The existing owner command journal, release publication proof, immutable contract version checks, deny-first protections, retry handling and withdrawal checks are retained. No new secret, public endpoint, positive authorization shortcut, or production lease is introduced.

## Rollback / release restrictions
Production legal owner remains disabled, and direct production canonical D1 privileges may not be removed until remaining families have been migrated. Reversing this commit must not re-enable shared direct writes while any owner materialization, activation or preorder journal can be pending or while the product is denied. On error or lost ACK, keep the owner product veto and reconcile exact publication version, owner command ID, primary database row state, rights grants, contract version, offer state and source asset permissions before deciding whether a brand-new owner command is legal. Never mark a partial D1 write as a successful publication or reauthorize an existing withdrawn grant. Confirm deployed production private bindings, publishing/commerce/writer topology, positive and negative media authorization, rollback routing, and all background jobs separately before activating production.

The reduction in the static audit is a genuine deletion of callable application SQL statements, not proof of independently certified production writer-only ownership or completion of the remaining migration.
