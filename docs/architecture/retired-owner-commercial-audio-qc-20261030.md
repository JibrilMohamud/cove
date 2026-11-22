# Commercial audiobook QC authority (QA only)

Seven direct commercial-audio SQL writer sites were physically removed from the shared API. QC leasing and completion now use a fixed typed private-owner command. Current lease ownership, manifest and policy are rechecked by the owner; it updates the R2-backed quarantine and QC outcome metadata through its independently bound primary DB.

Historical SQL lineage and updated source hash are in `retired-owner-commercial-audio-qc-lineage.json` and `retired-owner-commercial-audio-qc-attestation-20261030.json`. Remaining owner-required findings on this PR: **223**, compared to **230** before QC retirement and **260** on main.

**Release-blocking:** This is a QA-only owner lease. Audio/malware worker identity and positive scan reports are not independently attested, and replay/recovery and real customer paid-access certification remain incomplete. Do not deploy or merge as a production paid authorizer; production authority, Stripe, and public routing remain locked. `releaseApproval=false`.
