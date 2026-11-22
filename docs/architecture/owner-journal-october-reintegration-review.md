# Owner source integration: current QA mutation journal proof

The October owner stack introduces exactly two private Durable Object SQLite tables *before* the current owner mutation journal enrolls: `cove_audio_metadata_command_receipts` and `cove_finance_command_receipts`. Both hold command identifiers, exact request digests and replay receipts; both are mutable and must count toward the owner's monotonic mutation epoch. They do not authorize sales or historical rights.

This change adds those two table identities to the journal's **closed schema manifest**. Its verified table count rises from 24 to 26, and its exact generated mutation-trigger count from 78 to 84 (three DML triggers per table). All trigger integrity, immutable manifest, nonvirgin initial-state rejection, rollback rejection and current owner epoch checks remain enforced. Unexpected tables and schema drift still throw `qa_current_owner_mutation_schema_unreviewed`.

The separate November search-quality source file only moved the same exact non-authorizing quality-score SQL to a different line. Its exact SQL fingerprint, function, protected table, operation and reviewed disposition are unchanged. The source-bound `siteId` was updated to the **already independently reviewed main** identity, not reclassified.

The integration remains QA-only and `releaseApproval=false`; positive external legal evidence, independently complete withdrawals, physical primary-D1 exclusive authority, LIVE payments and protected rollback are not certified by these source changes.
