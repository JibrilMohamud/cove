# Source retirement: canonical rights grant writer (6 findings)

The original protected `upsertRightsGrant` contained six scanned authorizing
SQL sites. Its entire transaction is now `upsertRightsGrantPrivate` inside the
private `CoveLegalAuthority` Durable Object. Historical original function SHA:
`efea1af346283611e2255495b1f29d9eb61a8e1b2a9a1b27d019290da00a66ee`. The new source parity assertion reconstructs that function byte
for byte from the private code, except a local-only `now` helper declaration
and renamed function signature. No original write logic is changed.

The private publishing materialization path invokes the unexported writer
under its existing authenticated owner command and immutable publication
submission/reviewer/rights checks, holds, journaling and fail-closed semantics.
Public shared export `upsertRightsGrant` returns 503 and contains no protected
mutation; unenrolled editor writes are paused rather than bypassing the owner.
All pure validation and territory-scope read helpers remain available, without
granting mutation capability to the outside runtime.

No deployment or production owner enablement, no live writer credential
retirement and no external principal certification. Source retirement can be
rolled back with a reviewed Git revert while retaining production owner
disabled and without inferring positive rights. Before enabling the owner in
production, independently validate grant/contract associations, territory and
DRM checks, concurrent revocation, replay, provider/refund authorization and
the deployed rollback and database privilege fences.

Validation gate: canonical exact SQL audit and frozen exception lineage,
byte-exact rights grant and contract parity tests, private owner publishing
materialization integration, primary fail-closed when disabled, strict lint and
TypeScript, full rights and commerce CI, and no public authorization rollout.
