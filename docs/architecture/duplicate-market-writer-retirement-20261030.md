# Retirement evidence: duplicated optimized storefront market writer

## Before

The canonical localization backend and the experimental, optimized storefront presentation module both exported an `upsertMarket` function with **byte-identical 3,177-character implementation**. Each independently contained `INSERT INTO storefront_markets ... ON CONFLICT DO UPDATE`, as well as the same territory/locale validation, accompanying locale/currency inserts and privileged-access audit. The optimized copy was a second source-level canonical writer, counted as exactly one owner-required SQL finding under `localization-optimized.upsertMarket`.

## Change and behavior proof

The optimized module now **re-exports** the existing canonical localization implementation instead of retaining a second copy of the executable SQL. Its exported API name, argument contract, actual validation, transaction grouping, and returned value remain those of the canonical implementation. Comparison before editing showed the two entire function implementations were byte-for-byte identical, not merely equivalent SQL snippets. No functionality is disabled or replaced by a stub; all callers of the optimized export reach the same existing canonical code. The original `src/features/fore/localization.server.ts` SQL remains under its exact, unmodified owner-required audit disposition.

This is a true removal of one duplicate direct SQL implementation, not a relabeling as telemetry or a fabricated owner command. The 426 reviewed executable canonical SQL sites are reduced to **425**, and the 371 owner-required sites to **370**, assuming the protected source scanner and full CI verify the edits. It does **not** make the remaining canonical localization writer owner-controlled, and cannot authorize production paid access. The other 56 commerce server SQL sites still exist.

## Evidence and rollback

- Independent exact duplicate source comparison: both `upsertMarket` function bodies matched byte-for-byte before editing.
- The optimized module now exports the original function directly, retaining staff entitlement/territory/locale validation, canonical SQL, and audit behavior.
- The frozen original source-review row is deleted only because its SQL literal is actually absent. No other dispositions, source identities, or canonical writer sites are changed.
- The source attestation binds the replacement optimized module to its SHA-256 checksum.
- The canonical writer scanner/reconciler and TypeScript/checks remain independently required, with full production cutover still blocked.

Rollback: revert the optimized-module re-export and corresponding reviewed registry deletion together; this restores the extra duplicate writer and increases the audit count, not a production ownership claim. No Cloudflare/D1 setting, payment provider configuration, or production principal changed.
