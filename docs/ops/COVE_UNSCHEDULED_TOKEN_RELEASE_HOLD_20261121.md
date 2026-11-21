# Cove unscheduled Cloudflare-token consumers — reviewed release hold

Status: protected source-only PR; no deployments or live credentials changed.

The following three existing workflows had **no scheduled trigger**, yet could
run a broad Cloudflare API credential from a `main` source push:

- `continuous-publication-qa`: isolated QA Worker deploy and next-cron read
- `literary-activation-readiness`: production metadata read-only assessment
- `verify-production-disabled-owner-handshake`: temporary verifier Worker

This PR permits those privileged jobs only with manual `workflow_dispatch`
on the exact reviewed `main` commit, explicit confirmation and GitHub
`cove-production-release-audit` protected-environment approval. The original
PR-time credential-free checks and operational workflows remain available.
No Cloudflare resource is changed by merging their source constraints.

**Deliberate non-scope:** `biosync-canary` (hourly),
`cove-sounds-verified-conversion-report` (daily) and
`literary-isolated-utc-budget` (four times daily) have active scheduled work.
Do **not** disable those schedules through the six-workflow draft PR #785
until reviewed least-privilege substitute credentials are installed and
independent scheduled operation evidence passes. Those broad-token privileges
remain a separate release-safety blocker. This PR is not a writer-exclusivity
certificate, legal-owner activation, refund, rollback or performance approval.

The manual jobs still reference the existing broad account token at protected
environment scope. The token must be separately inventoried, minimized and
retired before full production release. All main-branch release gates remain
unchanged; no public aliases, Worker deployments or legal decisions are
promoted by this change.
