# Verified regional EPUB repair: isolated Cloudflare smoke

On 2026-10-20, the EPUB repair logic was executed by an ephemeral Cloudflare
Worker using **dedicated staging** resources, not Cove's production bindings.

- D1: cove-content-repair-stage-20261020 (ENAM / IAD).
- Private R2: cove-content-repair-stage-20261020.
- GitHub Actions: https://github.com/JibrilMohamud/cove/actions/runs/39403569258
- Worker code SHA before smoke cleanup: 4213ee5e3a8b656b643368578051f8d9ee6ad2e6
  (the Worker was removed after testing).

The Worker first uploaded a *synthetic metadata-only test object* with
content type application/epub+zip and SHA metadata. It then executed the
real repair helper through bound D1 and R2.

Actual result:
- Selected exactly two rights-approved, completed, unlinked regional fixtures.
- Repaired one fixture whose private R2 HEAD matched the expected content
  type and content SHA field.
- Rejected one fixture without any private R2 object.
- Never repaired a separately quarantined fixture.
- Replaying the repair returned zero additional repairs (idempotent).
- The temporary R2 test object and staging Worker were deleted.

This test verifies R2 object *metadata gate* and D1 rights guards.
It does not validate EPUB container integrity or full offline/browser reader
delivery; the staging object contained test bytes, not a legitimate ebook.
A separate real-source AU/CA/EU customer journey remains an explicit release
gate for any bulk production repair.

Production D1 and R2 were queried **read-only** to corroborate three AU
samples whose real R2 object metadata SHA values matched D1; each has an
AU-only active rights allow. No production book or grant was modified.

The repair HTTP path is disabled unless
FORE_REGIONAL_EPUB_REPAIR_ENABLED=1 and requires the existing backend gateway
authorization plus a primary-D1 admission check. Bulk repairs must remain
bounded and must not run under slow-primary conditions.

Release requirements before enabling a production backfill:
1. Verify final immutable SHA and all security, backend, browser, SEO and
   customer journey regressions.
2. Stage representative real EPUBs, verify live rights withdrawal and
   reader delivery in matching and nonmatching territories.
3. Run independent paired mixed-load tests with backfill enabled to establish
   database headroom at 1/4/8/16/32 and 25/50/100-RPS arrivals.
4. Backfill only verified R2 objects with checkpointed cursor, maximum
   16 entries per operator request, bounded delay and immutable audit receipts.
5. Confirm completed assets reconcile and observe production rights and
   reader success before increasing throughput.

The stage resource remains available for isolated testing; the test Worker
does not remain running.
