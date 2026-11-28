# One-time production owner binding transfer

This maintenance operation copies the seven existing backend bindings listed in `production-owner-secret-transfer.mjs` to the production owner. Values stay inside Cloudflare. It does not enable legal issuance, remove any D1 binding, move Durable Object state, change schedules, or certify the cutover.

The backend has a newer **archived** version than its deployed version. The operation reads exact active version IDs and uses the Worker-version API's UUID-pinned inheritance. It never uses `latest` or rebuilds existing runtime modules. Named transfer entrypoints are added around the exact original modules; ordinary HTTP handlers and existing exports remain the original implementation.

A provider-resolved one-hour credential can edit only the existing production owner Worker. Runtime transfer authority expires after ten minutes. Two private service calls first verify that the existing owner authentication secret matches. The sender can copy only the fixed seven names to the fixed owner; it cannot expose values, choose another destination, write D1 or call a generic administrative operation. The receiver's nonce-keyed proof verifies every copied value. An acknowledgement retry inspects the receiver before deciding whether copying is necessary.

The temporary verifier has no D1 binding. Its only HTTP action requires the operation's random credential, has a fixed path and no body, and returns binding names and matching status. The public endpoint is closed during cleanup. Logs and returned receipts contain no secret values or proof digests.

Cleanup revokes the temporary credential, restores the original runtime modules, removes temporary bindings and entrypoints, parks the verifier, and independently checks schedules and public-subdomain settings. Successfully copied bindings remain on the owner. Partial installation and lost deployment acknowledgements are covered by tests. A cleanup failure is a hard error and must be resolved before any subsequent cutover action.

Run only the reviewed source from current main through the authorized Cloudflare administrative connection. Pass matching current/reviewed main SHAs and the exact `copy-seven-existing-backend-bindings` confirmation. The executor supplies `cloudflare.request`, runtime `fetch`, and an awaited timer to `runProductionOwnerSecretTransfer`. Do not log request bodies or credentials. A successful receipt is configuration evidence only; the full legal baseline and production acceptance remain separate requirements.

Local contract checks use disposable native service bindings and test-only values. The pinned local workerd supports compatibility dates through October 19; its fixture uses October 17. Production preserves each existing Worker's actual compatibility settings. Native fixture success does not replace provider-side verification.
