# Rights-authoritative regional EPUB release evidence — 2026-10-20

## Real-object inspection (read-only)

GitHub Actions [run #39407854055](https://github.com/JibrilMohamud/cove/actions/runs/39407854055) passed after deploying an ephemeral authenticated Cloudflare Worker that bound the existing **production** D1 and **private** R2 buckets with *read-only application code*. No D1/R2 mutations, customer routing changes, or new public asset URLs were performed.

The Worker checked three already-known Australian Gutenberg source IDs: `pgau_0100031`, `pgau_0100041`, and `pgau_0100051`.

For **each**:
- Source record status remains completed, active and commercially approved.
- Live D1 retail/ebook grant permits `AU`; **no live US grant** exists.
- Exact R2 EPUB object's private metadata SHA matches the D1 source content hash.
- EPUB object Content-Type is `application/epub+zip`.
- EPUB bytes parse as ZIP, contain the required `mimetype` file, EPUB container, a declared root package file and its XML OPF package marker.
- No content, chapter excerpts or customer identifiers were written to the test report.

Exact result: `{"pass":true,"checked":3,"deniedUS":3}`.

The ephemeral Worker was deleted after testing. These checks are real-object **structural integrity and grant-state validation**. They do **not** prove paid/signed-in checkout, client DRM, full chapter rendering, mobile offline access, or geo-location enforcement. Those are separate release gates.

## Staging rights-revocation fixture

The isolated D1 `cove-content-repair-stage-20261020` includes an additional source fixture which is still `commercial_use_status='approved'` but whose source-matched AU retail/ebook grant is explicitly `revoked`. The grant check returns **0** for that book and **1** for the otherwise comparable active-grant book. The enhanced repair code in the dependent PR requires a current grant both at candidate selection and at each write, so independently revoked rights cannot be bypassed by an unchanged source flag.

## Live production backlog audit (read-only)

At the time of the audit, source-completed records lacking normalized EPUB asset pointers and eligible under source approval and live grants comprised:

| Source | Missing normalized reader asset | Live grant present at audit time |
| --- | ---: | ---: |
| Project Gutenberg Australia | 3,515 | 3,515 |
| Project Gutenberg Canada | 97 | 97 |
| Total | 3,612 | 3,612 |

The aggregate read examined ~39,492 D1 rows and required ~871 ms SQL execution time; repeat full-database counts are **not** suitable for a latency-sensitive primary-D1 request path. The operator backfill has a per-request cap and admission guard, but still requires controlled rate limiting, durable receipts, benchmarked write budgets and a separate real geographic reader journey before any production rollout.

## Release decision

The producer Writer and reader remain backed by the primary shared D1. **No commercial release authorization** follows from these checks; all production repair and independent-processor activation flags remain off. The full combined PR #241 must integrate the rights-hardening changes and pass its own immutable-SHA regression suite before any merge. No staff licensing/rights decisions on music were made.
