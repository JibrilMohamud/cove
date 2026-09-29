# Cove security program

Cove treats application controls, edge controls, identity, supply chain, publishing uploads, payments, incident response, and recovery as one security program. The database stores control/evidence state; external providers remain authoritative for controls Cove cannot safely implement itself.

## Threat modeling

`security_threat_models` versions system data flows, trust boundaries and assumptions. `security_threats` records STRIDE/fraud/supply-chain/privacy scenarios with likelihood, impact, owners, treatment and mapped controls. Approved models should be reviewed for material architecture changes and at least annually.

## Edge protection

Production must use managed DDoS protection and WAF blocking. Bot management can monitor/challenge/block based on surface. `security_edge_controls` stores the provider/config/evidence reference; it does not pretend application code can replace the CDN/WAF. Rate limits remain defense-in-depth at the application layer.

## Identity and privileged access

Human staff use individual Cove identities, staff RBAC, SSO binding where configured, and AAL2/MFA for privileged operations. Publisher mutations require AAL2. Workloads use separately rotated scoped service-principal credentials; a human admin token is never reused as an ingestion credential. Privileged authorization attempts are recorded through the existing privileged-access audit stream.

## Secrets and keys

Cove stores secret-manager *references*, never secret values, in `security_secret_inventory`. Rotation events are evidence-linked. Production secrets belong in the deployment/provider secret manager, should be independently scoped by workload/environment, and should be revoked immediately on suspected compromise.

## Secure build / supply chain

`.github/workflows/security.yml` performs dependency audit, secret scanning, lint/type checks, CodeQL SAST, security-domain regressions, build, CycloneDX SBOM generation, and build provenance attestation on main. `security_scans`, `security_sboms`, and `security_build_provenance` persist the resulting evidence through the machine security API. Production release promotion should require successful high/critical vulnerability gates and verified provenance. Finding triage is explicit: accepted risk requires an owner, documented reason, evidence/reference and an expiry no more than 180 days out; fixed findings require remediation evidence. Expired acceptances become release-blocking again.

## Publisher upload malware scanning

Publisher manuscript, cover and audio assets remain quarantined until required validators complete. Malware validator results are mirrored into `security_scans`; failed/blocked required validation leaves the asset rejected/quarantined. Scanner workers must execute in an isolated sandbox with no ambient production credentials and store only report/evidence references in Cove.

## PCI scope

Cove does not collect or persist PAN/CVC. Card entry is delegated to the payment provider's hosted/client payment components and Cove stores provider identifiers/statuses only. PCI scope and SAQ applicability must be revalidated whenever payment architecture changes; this document is not a substitute for a QSA/acquirer determination.

## Deployment security headers

The server emits CSP, HSTS (HTTPS non-development), Permissions Policy, Referrer Policy, X-Content-Type-Options, frame denial, COOP, CORP and Origin-Agent-Cluster. Because a reverse proxy/CDN can strip or overwrite headers, production is not considered verified from source code alone. An external probe must submit observed headers to `/machine/v1/security/headers` (or staff `/admin/security/headers/verify`) with evidence; only passing observations update `security_header_policies.last_verified_at`.

Current CSP contains inline-script/style allowances for the existing hydration/runtime path. Treat nonce/hash-based removal of those allowances as a planned hardening item; do not claim a stricter policy than the deployed application can actually run.

## Vulnerability disclosure / pentesting

`/.well-known/security.txt` points researchers to `/security` and the configured security contact. Reports receive durable references in `security_disclosure_reports`. Authorized penetration tests are tracked in `security_pentest_engagements`; an engagement cannot be closed while critical/high findings remain open. Scope/rules of engagement and third-party authorization must be established before testing.

## Incident response

`security_incident_response_plans` defines severity, roles, communication, containment, evidence preservation and notification assessment. `security_incidents` tracks declaration through containment, eradication, recovery, resolution and postmortem. Legal/privacy teams determine jurisdiction-specific notice duties; those deadlines are not hard-coded into product logic.

## Minimum production gates

The operations deployment state machine enforces this for ordinary production promotion. A release must have verified provenance, an SBOM, passing dependency/secret/SAST evidence with no critical/high findings, and fresh production header + WAF/DDoS verification. Emergency promotion requires an explicit `securityExceptionReference` in the deployment health evidence.

A production release should fail closed when: required dependency/SAST/secret scans fail; provenance is missing; required security header/edge evidence is stale; a critical open finding lacks an approved exception; restore/SLO controls are unhealthy; or release-specific threats are unreviewed. Exceptions require an owner, expiry, compensating control and audit evidence.
