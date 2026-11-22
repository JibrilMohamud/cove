# Primary D1 writer retirement — November 22, 2026

Exclusive primary-D1 write authority remains **BLOCKED**. This change removes
one source dependency on the broad deployment credential; it does not remove
the live credential, its privileges, or the backend's native binding.

## Read-only topology consumer migration

`production-cutover-topology-audit.yml` previously exposed the generic
deployment token to a read-only job on matching main pushes. Its live job now
requires a manual dispatch, exact reviewed main SHA and protected release-audit
environment. Push/PR jobs run credential-free source tests only.

The transport has five fixed GETs, a five-request cap, no redirects, no D1
operations, no arbitrary paths, no retries, no raw provider error output and no
generic deployment-token fallback. Only a missing optional frontend Worker can
return null; unavailable owner, backend or routing evidence stops the audit.

| Protected environment secret          | Intended provider permission                                                     | Fixed requests                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `COVE_CF_WORKERS_METADATA_READ_TOKEN` | Workers Metadata Read-Only                                                       | Settings for the production owner, persistence backend and frontend |
| `COVE_CF_WORKERS_TOPOLOGY_READ_TOKEN` | Workers Scripts Read for the Cove account, Workers Routes Read for the Cove zone | Account Worker custom domains and zone Worker routes                |

These are independent read credentials. The two routing endpoints require the
documented Scripts Read and Routes Read permissions, respectively; a purpose
label or a Metadata Read-Only token is not enough. They require no D1 Write,
Workers Write/Admin/Editor or token-administration permission.

The second caller, the already manual/protected locked-owner deployment, now
supplies these readers and validates their presence **before deployment** so a
missing post-deployment reader cannot cause a partial operation. That job still
has its existing deployment credential for the actual deployment operation;
this change does not certify or retire that separate write consumer.

No token value was created, copied, logged or installed. Installation of the new
topology reader in the protected environment and a successful protected manual
run remain unverified. Missing credentials fail before any topology request;
there is no fallback to the broad token. Source tests are not a hosted proof.

## Independently checked remaining blockers

- Current main is `686f937660549377b183d651cd7d64158e5c8066` at review.
- A fresh source inventory reports 260 owner-required SQL sites across 118
  command families, with zero independently production-certified families.
  This TypeScript/JavaScript protected-table inventory is a lower bound, not
  an inventory of every possible write to primary D1.
- Read-only Cloudflare settings still show the disabled production legal owner
  (`COVE_RIGHTS_OWNER_ENABLED=0`) and the persistence backend both bound to
  primary D1. Removing the backend binding now would interrupt legitimate
  operations before its replacement is certified.
- A complete account-token listing contains 13 active tokens. A separate
  detail GET confirms the broad `Cove GitHub Deployments` token retains D1
  Write, Workers Admin/Editor/Scripts Write and Account API Tokens Write among
  385 permission-group grants. No permission was changed or revoked.
- Stage Workers Scripts Write is account-scoped; the protected version upload
  token has Individual Workers Editor. Their names do not establish immunity
  from indirect primary-owner mutation; they need explicit scope/consumer proof.
- The connector's independent user-token listing returns HTTP 403. The latest
  available protected user-token diagnostic, run `44942773565`, instead reached
  the configured user credential and failed with
  `active_user_token_permission_unreviewed` /
  `read_group_alias_identifier_mismatch`. These are different evidence sources;
  neither establishes a clear full user-token inventory. A fresh browser
  dispatch was attempted but no new run appeared, so no execution is claimed.
- The scheduled Python BioSync canary directly inserts/updates `audio_timing`
  and updates `audio_jobs` through the primary D1 API. Those tables are outside
  the canonical protected-table registry and Python is outside its scanner.
  These two operations still need a supported typed-command migration with
  identity/lease/idempotency proof; moving the same generic SQL executor behind
  another token or disabling the job would not complete the migration.
- Literary UTC rollover reads primary state and mutates its separate isolated
  budget database using a broad credential. Its replacement must preserve the
  previous-day certificate, budget carry and lease checks while removing any
  capability to mutate primary D1.

Genuine external legal authority and withdrawal history are still required
before positive production-owner publication. That prerequisite cannot be
created by removing bindings, issuing new local signatures or starting an
empty owner epoch. Complete the typed write replacements and protected rollback
before retiring backend/native and token authority, then repeat the independent
physical audit. No production data, deployed Worker, credentials, routing,
owner enablement, customer payment or performance threshold was changed here.
