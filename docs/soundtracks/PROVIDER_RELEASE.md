# Commercially authorized FMA/Musopen delivery: controlled Cove release

Provider tracks are **not downloaded from FMA/Musopen websites by this pipeline**. The third-party sites' license records are useful evidence, but ordinary site-use contracts may separately restrict automated harvesting and commercial mirroring. Obtain a dated explicit delivery/access grant from the relevant site/provider or directly from the master rights holder, and retain a track-specific composer/performance/master license assessment.

## Production architecture

This path is separate from Commons:
- A service account scoped to soundtracks.review registers the original's source page, canonical CC license (or Musopen U.S. PD claim with independent provenance), grant, five-layer rights dossier and exact FFmpeg QA report. Insert defaults to pending_review and is idempotent only for the **same** source, master hash and rights evidence. State is not public.
- The same scope uploads an operator-delivered original MP3/OGG as binary PUT through the Worker, at most 25 MiB. Request byte count must match; R2 validates the submitted SHA-256 while streaming. The object is private in cove-production-media. Status becomes staged, still non-public.
- Only a signed-in human Cove staff member provisioned with soundtracks.review and multi-factor authentication can approve. The reviewer must inspect provider access permissions, source license, exact master, five-layer dossier, and personally listen to the original. The backend rechecks provenance digest, quality gate, and stored object before switching the single row to ready.
- Only ready records in the applicable territory appear in /soundtracks/recordings; byte-range playback reads the same private R2 object. No public R2 URLs are exposed. Revocation removes the ready entitlement first and then deletes the object; cleanup errors must be followed up operationally.
- Append-only soundtrack_external_events track original registration, uploads, approvals and revocations.

### Boundaries and limitations

The API verifies structural evidence, origin selection and file digests, not whether a provider's evidence URL or granting party is legally authentic. A trained staff reviewer must independently evaluate rights. A supplied FFmpeg report cannot prove the submitter used an unmodified tool; it is an authenticated assertion that should be backed by runner logs and reviewer listening. Other territories beyond US are not automatically authorized.

The POST/PUT endpoints are authenticated, not a customer-upload service. In particular, do not put the service token in browser scripts or repository files. Always submit via a confidential operator machine or authorized delivery job. The delivery client refuses HTTP/redirecting origins, never requests FMA/Musopen themselves, and never invokes approval.

## Repeatable delivery workflow

1. Put each original audio file in a private directory, not a Git repository or a public artifact.
2. Prepare a schemaVersion 1 per-recording manifest as specified in PROVIDER_INTAKE.md. For FMA commercial CC recordings, supply either a genuine delivery grant or an exact-track acquisitionEvidence object with method manual_download, sourcePageUrl, acquiredAt (UTC ISO timestamp), noAutomatedProviderAccess=true, and originalUnmodified=true. Manual acquisition never permits FMA bulk scraping. Musopen requires a separate genuine authorization for its website delivery, or independently supplied rights-holder originals. All five rights layers and credits must be attributed.
3. On a machine with FFmpeg installed:

       python scripts/soundtracks/external-source-intake.py --manifest /secure/manifest.json --audio-dir /secure/masters --output /secure/review-receipt.json

4. Privately preview the registration and audio integrity:

       python scripts/soundtracks/submit-authorized-provider.py --manifest /secure/manifest.json --receipt /secure/review-receipt.json --audio-dir /secure/masters --output /secure/preview.json

5. Using an authorized secret manager, set COVE_SOUNDTRACK_REVIEW_TOKEN and COVE_SOUNDTRACK_API_ORIGIN to the deployed production Worker origin. Use --apply only after verifying the manifest and receipts:

       python scripts/soundtracks/submit-authorized-provider.py --manifest /secure/manifest.json --receipt /secure/review-receipt.json --audio-dir /secure/masters --output /secure/private-stage.json --apply

   The client supports 20 originals at a time and rechecks the exact file hashes before uploading. Source-page data must remain HTTPS and tied to the individually licensed master. Repeatable attempts reuse a pending identical source record but never overwrite an existing ready recording.
6. Have an authorized human Cove staff reviewer inspect /admin/soundtracks/external, the exact record and its audit history. POST /admin/soundtracks/external/<id>/approve with provenanceSha256 from registration, a substantive >=100 character assessment, sourceLicenseChecked=true, providerPermissionChecked=true, exactMasterListened=true. This endpoint requires an MFA-authenticated *staff session*, not only a service token.
7. Validate public US streaming, attribution/license display, 200/206 byte-range responses, forbidden territory responses, and a dry-run takedown. The production library count must use ready + a retrievable R2 master, not pending/staged candidates.
8. For a rights notice or suspicious original, POST /admin/soundtracks/external/<id>/revoke with a reason >=20 characters. Confirm the recording disappears immediately and object cleanup completes. Review immutable events.

## For the 150–300 target

The reviewed library contained 17 playable Commons files at the last audited production snapshot. To reach 150, obtain and inspect at least **133 more** originals; to reach 300, **283 more**. If 10–20% fail provenance, technical QA or editorial checks, source more than the bare minimum. Neither candidates nor safely staged files count as released. No source-specific rights holder, full audio asset or site-use grant has been provided as part of this repository change, so these tools **cannot** truthfully claim that the goal is already reached.

## Automation

Commons: existing GitHub Actions curator every hour, bounded 8 tracks/run, depends on a matching service credential. An active database credential alone is insufficient when the GitHub Actions secret's value differs: production audit observed credential_not_found (HTTP 401); rotate the secret securely before relying on cron.

External licensed provider deliveries: run staging **only when a verified delivery and signed license have arrived**. Scheduled polling or scraping FMA/Musopen is intentionally absent. Once an actual provider feed/API agreement exists, implement an adapter using its documented authenticated API and quotas to feed the same staging contract. Apply per-source cool-downs, periodic revalidation and rights takedown controls; never shortcut human approval for ambiguous masters.

## Licensed FMA fast lane

Clear CC0, CC BY and CC BY-SA declarations on the exact recording can remove the need to negotiate individual copyright licenses. The file must still be lawfully acquired manually (or supplied under another authorized channel), checksum-matched, QA-verified and individually approved by an MFA-authenticated staff reviewer. An acquisition attestation is not a guarantee of third-party rights. Mark unknown instrumentation honestly and retain an auditable takedown path. No automatic provider-site scraping is enabled.

## Post-deployment release safety and production health

The Commons curator runs hourly and can approve at most eight exact-original, FFmpeg-verified and license-matched recordings per run (160 MiB total). After a successful production Worker deployment, the separate bounded bootstrap workflow can approve another eight, after migrations have completed. The Worker imports up to two verified originals every ten-minute tick.

The curator marks unsuitable automatic candidates with `automated_triage_reason` while leaving `status=pending_review`. This is **not a copyright rejection or a license clearance**. It removes non-automatable records from the automatic discovery backpressure count, but the staff queue remains accessible for ordinary human rights review. A versioned, append-only audit event records each triage; automated release never treats it as approval.

Source-license API reads retry HTTP 429/502/503/504 transient errors with a bounded backoff. Mutation requests are **never retried automatically**, to avoid duplicate submissions after uncertain outcomes. Periodic public playback health checks retrieve the exact approved catalog and verify sampled `HEAD 200` and `GET Range 206` bytes from Cove's streaming endpoints, with attribution and license links. The daily check fails if public playable coverage remains below 150 or any sampled recording is broken. Health artifacts contain no credentials.

Track counts remain distinct: pending candidates; manually triaged candidates; QA-measured originals; approved but pending R2 import; and **playable** (production catalog returned with a real 206 range response). Until production reaches 150, no operator should describe the library as complete or commercially launch-ready. Musopen/FMA website extraction is not enabled; FMA originals must be lawfully acquired with recording-specific commercial CC rights or an authorized delivery, and Musopen originals require authorization before site delivery.

## Continuous publication capacity and full-library audio coverage

Cove now runs two staggered, bounded hourly GitHub Actions music jobs. The source-license curator runs at minute 19 and can examine/QA/approve up to 12 individually licensed Commons recordings (160 MiB, 20 minutes, maximum 80 non-automatable manual referrals). The verified-publication bootstrap runs at minute 37, subject to the **same concurrency mutex** and rights checks, and can approve up to 12 and then import and verify up to 12 originals in private R2. The Worker continues its bounded two-import-per-ten-minutes fallback. GitHub schedules are best effort, not guaranteed execution times; inspect real receipts and `ready`/R2 parity before counting new recordings.

The public playback audit checks 50 distinct recording identities every six hours. It rotates deterministically through a permutation of the catalog, so all 300 are sampled within six completed consecutive runs when catalog membership is stable. It validates attribution and exact license URLs, public HEAD length/type and GET byte-range 206 playback; even a successful sample does not prove every track outside that sample works. Any missing audio is a failure, and the unmet 150-recording minimum remains an explicit release-readiness failure until achieved.

The hourly schedules do not scrape, mirror, or download from FMA or Musopen. FMA CC commercial originals require independent lawful file acquisition and rights evidence; Musopen deliveries require authorization. NC-tagged recordings remain ineligible.

## Reconsidering previously triaged sources safely

A previous `automated_triage_reason` is **not** a rights verdict. Source-title policy improvements may now recognize additional historical composers and named performers. The staff-only `automation=triaged` queue returns **only** recordings held because the composer was outside the prior narrow mapping, not recordings held for missing performer evidence or complex arrangements. This restriction prevents automatic reclassification of substantive rights questions.

The `reconsider-triaged-soundtracks.yml` job runs weekly and immediately after a successfully deployed backend update. It uses `--reconsider-triaged --max-triage 0` with the same commercial-only Creative Commons license checks, exact-source SHA, FFmpeg QA, source snapshot and Worker-controlled R2 publishing as the normal curator. Each new approval produces its own immutable review history. Human staff can still inspect the original triage reason; no file is cleared by merely removing a queue marker.

Production playback health independently validates the actual public license URL against the allowed US commercial CC0/CC BY/CC BY-SA or explicit Commons/Musopen public-domain source declaration. It rejects NC, mismatched BY/BY-SA declarations, non-HTTPS license destinations and missing US territory rights **before** any audio is counted as playable. This is a metadata consistency safeguard, not an independent guarantee that a declarant owned the rights.

## Continuous rights integrity for released Commons masters

The production Worker now rechecks **two already-published Wikimedia Commons originals every ten-minute ingestion tick**, roughly 288 validations per day (upstream rate limits or outages may reduce throughput). A prior approval is not a permanent guarantee. The check fetches each individual file's current declared commercial license, license URL, exact SHA-1, byte size, audio type, and immutable source URL.

* **Matched source:** record `rights_checked_at` and retain playback.
* **Temporary Commons HTTP/network failure:** record `rights_check_error=upstream_unavailable`, keep the prior evidence and playback temporarily, and retry after one hour. No rights claims are inferred from an error response.
* **Confirmed source-license or master identity conflict:** atomically set `status=revoked`, remove territorial access and public media references, append the independent rights decision and immutable review event, queue the old object for deletion, then attempt immediate R2 cleanup. This is not an automatic *relicense*: human staff must investigate and provide fresh evidence before any re-release.

The source recheck is deliberately limited to the Wikimedia Commons-backed `soundtrack_recordings` table. External FMA/Musopen originals have separate individual staff approvals and require their own monitoring/provenance agreements when supplied. Avoid interpreting this operational safeguard as independent proof that every Commons uploader owns all composition, performance and master rights.
