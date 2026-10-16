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
2. Prepare a schemaVersion 1 per-recording manifest as specified in PROVIDER_INTAKE.md. Each grant must explicitly authorize **commercial download and redistribution** of the exact recording. Do not invent permission URLs. All five rights layers and credits must be attributed.
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

Commons: existing GitHub Actions curator every six hours, bounded 8 tracks/run, depends on a matching service credential. An active database credential alone is insufficient when the GitHub Actions secret's value differs: production audit observed credential_not_found (HTTP 401); rotate the secret securely before relying on cron.

External licensed provider deliveries: run staging **only when a verified delivery and signed license have arrived**. Scheduled polling or scraping FMA/Musopen is intentionally absent. Once an actual provider feed/API agreement exists, implement an adapter using its documented authenticated API and quotas to feed the same staging contract. Apply per-source cool-downs, periodic revalidation and rights takedown controls; never shortcut human approval for ambiguous masters.
