# Detached commerce buyer source reconciliation — 2026-11-25

Scope: PR #916, source commit 8f555a28c9901a167c3e91cf5a0ede3d63c59dbb. This is an implementer-performed exact-source reconciliation, not independent reviewer approval or production authority.

The settlement executor diff adds a shared buyer-ID validator import and replaces only the canonical order's buyer-ID predicate. Legacy internal buyer IDs are preserved; the additional accepted namespace is an exact Supabase UUID prefixed with sb:. The order ID still uses the original separate validator. No SQL, parameters, settlement sequence, provider verification, rights comparison, market denial, refund tombstone, or owner-only import boundary changed in the executor. The existing two UPDATE literals retain their exact SQL SHA-256 values, functions, tables, dispositions and reasons. CI run 45714902413 reported the two replacement source-bound site IDs at lines 120 and 127. Reconciliation changes only those IDs and line numbers. Frozen exception lineage and releaseApproval=false are unchanged. The source containment test still must pass.

An independent review of the broader owner allowlist, identity handling, caller configuration and new fixture deployment remains outstanding. No historical attestation is rewritten, no protected run is claimed, and no production release is authorized.
