# Website audit fixes 6–10

## Group margins

The reader sends the selected group ID with group discussions. The server verifies active membership and rejects missing or foreign groups. Replies inherit the parent's group and spoiler location. Database triggers protect inserts/updates. Existing group posts with no group are hidden rather than assigned to a guessed group.

## Direct sharing

Highlights, included notes, and margin discussions can be shared with one verified Cove username. Recipient IDs are explicit grants: they override the legacy database audience classification (`friends` for direct highlights, `private` for direct discussions). Every margin, thread, reaction, feed and inbox read applies the recipient grant and block checks. Direct content never enters broad activity feeds. Replies retain the same two members. Private reply notifications contain no passage or body excerpt.

The member picker resolves exact usernames, returns no email address, rejects self-sharing and blocked recipients, and respects the recipient's direct-sharing preference. Members can accept shares from all members, followed readers, mutual followers, or nobody. These preferences control new sends; existing grants can be withdrawn by the sender. Blocks hide existing content immediately.

## Sharing controls and inbox

Community has **My sharing** and **Shared with me** tabs. My sharing inventories active shared highlights, included-note flags, audiences, selected members/groups, and margin discussions. Highlight permissions can be edited or withdrawn. Discussion removal withdraws its thread and feed copies. Lists and reading journeys retain their existing controls in My profile.

The reader's highlight-sharing dialog also offers Unshare for a current share. Version checks prevent stale dashboard edits or revocations from overwriting another device's permission change. Inventories use keyset pagination with timestamp, kind, and ID, so identical timestamps do not skip items.

The receiving inbox applies current permissions, blocks and mutes. Passages, notes, bodies and locations ahead of the recipient's stored reading progress are omitted from the response. Receiving a share does not grant ownership of the book. The reader link opens a permitted location; normal book-access checks still apply. Open inventories revalidate every 30 seconds. Previously received or exported content cannot be recalled.

## Confirmed account erasure

Erasure remains subject to the existing cooling-off period and ownership/payment holds. Eligible jobs acquire a renewable lease with a unique token. Interrupted jobs resume, failures back off, and one failed account does not stop the queue. Maintenance runs the queue on the existing hourly schedule.

The pipeline verifies provider configuration before starting, disables the Cove identity before destructive cleanup, and records imported-object keys durably. It lists the account's upload prefix to recover orphaned objects from earlier incomplete runs. Storage failures are not swallowed. Database cleanup includes private import metadata, notes, bookmarks, sync snapshots/conflicts, reader settings, journeys, notification destinations, and the existing personal-data cleanup. Commerce/legal records retain their existing retention behavior. The disabled identity mapping remains as a replay fence.

Storage, database and identity stages each have a completion checkpoint. `completed` requires all three. Older completion records are requeued for reconciliation because the earlier implementation did not prove external cleanup. User-facing status reports delayed cleanup honestly; logs contain a request ID and failure code, not private data or credentials.

`cove-account-erasure` is a Supabase Edge Function that uses Supabase's server-only default credentials. The Worker signs a short-lived, purpose-bound P-256 proof with the existing server signing key. The function verifies its pinned public key, operation, subject, job ID, lifetime and signature before any admin call. It bans the identity, deletes it, and confirms `user_not_found`. No Supabase admin credential is copied to the browser or repository. The public trust key lives in the function source; update it alongside signing-key rotation. Native JWT verification is disabled for this function because its body implements signed backend authentication.

The optional existing `SUPABASE_SECRET_KEY` path also checks deletion responses and confirms absence. Missing credentials, HTTP failures, false success bodies and unconfirmed deletion leave the job retryable. Revoked access tokens are additionally denied by Cove's disabled-account fence while external cleanup is pending.

## Verification

`npm run test:sharing-erasure` runs the full migration chain, actual social APIs, recipient/group/reply permissions, note visibility and withdrawal, pagination ties, storage failures, identity denials, private import cleanup, active/stale leases, concurrent claims, ownership holds, and native signing/proof verification. The earlier SSR/offline/sharing suite includes both new Community tabs. These behavioral checks run in persistence and security CI.

Browser/device visual and interaction QA is still outstanding. Production rollout checks migrations, triggers, Worker/Vercel versions, and the deployed Supabase function without deleting a real member account as a test.
