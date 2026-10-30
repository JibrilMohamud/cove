# Private rights-contract mutation retirement (source only)

Historical main: `8df1d301399126d9dcd898844e4e366d608d6c05`.

The original shared `upsertRightsContract` path had three owner-required canonical
SQL statements (rights_contracts and rights_contract_languages) and one append-only
rights_configuration_audit statement. They were physically removed together.
The complete body of the implementation was transplanted without modified SQL into
an unexported `upsertRightsContractPrivate` inside the service-bound
`CoveLegalAuthority` Durable Object. The original shared API export fails closed
with 503 instead of retaining any D1 fallback. Existing private publication
materialization invokes the non-exported function, after the materialization command's
authenticated immutable submission, reviewer, legal-proof, owner-hold and replay checks.

No positive customer authorization, legacy staff contract editor, new grant or
production legal-owner enablement is claimed. Legacy unenrolled staff contract edits
are **deliberately paused** rather than allowed to write through the API.
The existing private QA publication path remains the intended functional route.

Source preservation: the full historical function body SHA-256 is
`9bfa170cca3c305d2137001b9d109e575d3c0f9a4487e655138ce9cd4a1e9b53` before the two private local-only helpers and function rename.
The dedicated parity check verifies that those syntactic additions are the only
differences in the transplanted business logic and no shared direct executor remains.
No other rights SQL text or reviewed classification was changed.

Check before merge: canonical writer inventory and exact SQL review, frozen exceptions,
private materialization and rights/commerce tests, stage disabled-owner denial,
strict type checking, real private owner integration and full CI.
Production legal owner remains DISABLED. Rollback is a source revert while retaining
the disabled owner; do not independently reactivate the direct D1 writer or make
rights positive without fresh validation. A production cutover additionally requires
all canonical writers/principals to be retired, multi-market rights and provider
journeys, concurrent withdrawal, idempotent failure recovery and live routing rollback.
