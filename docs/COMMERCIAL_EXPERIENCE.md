# Customer support, public status, and recovery

The October 2026 commercial-readiness review found substantial existing commerce, publishing, rights, account security, and staff operations functionality. This change closes three customer-facing gaps: customers could not maintain a support conversation, internal health was not visible publicly, and failed account/commerce requests could look empty or remain loading.

## Implemented behavior

- `/help`: searchable help articles and a private support inbox. Customers open categorized requests, optionally associate an owned order and diagnostic request reference, read replies, and reply themselves. Customers who cannot sign in can use the existing privacy/contact form.
- `/staff/support`: the new customer conversation workspace alongside the existing confidential staff case tools. Customer-visible replies never include existing internal case notes. Support read/manage permissions and verified MFA are enforced by the API.
- `/status`: background evidence for the bookstore database, a stored EPUB lookup, catalog progress, and BioSync coverage. It describes coverage limits explicitly; this is not a synthetic checkout, external identity-provider check, or device-level uptime claim.
- Reliability operations: staff with operations permissions and MFA publish customer-safe notices, update their state, and preserve an immutable revision history. Explicit active notices override automated component evidence. Internal incidents are never automatically published.
- Request recovery: bounded reads and writes, one retry for transient reads, no automatic write replay, offline/account notices, diagnostic references, and explicit retry/help screens for failed cart, checkout, order and account-management loads.
- Account changes clear the previous account's query cache and remount local customer state. New support, cart and order queries include the verified account ID.

## Integrity and operating limits

Migration `0044_customer_support_and_public_status.sql` introduces customer tickets, messages, public notices and notice revisions. Conversations enforce ownership on every customer operation. Staff roles are derived server-side. Creation and reply keys provide durable idempotency; changed payloads cannot reuse an existing key. Conversation versions serialize replies, and SQL triggers prevent stale writes or limit violations. Message sequence uses versions so equal timestamps cannot reorder a thread.

Each customer can have ten active requests. Inbox pages contain up to 25 requests; conversation pages contain up to 100 messages with earlier-page navigation. Creation and replies also use the existing rate-limit framework. Viewing version N only marks messages from that version read; a newer staff reply remains unread.

Personal exports are version 4 and include customer-visible support conversations. Account erasure removes customer tickets and their messages through cascading deletion after existing hold checks. Public notice audit history belongs to operational records and remains immutable. The support inbox currently promises replies in the inbox, with no newly introduced external email delivery dependency or response-time SLA.

The scheduled Worker refreshes public health after its catalog tick, normally every five minutes. Evidence older than 15 minutes, invalid timestamps or absent evidence becomes unknown. Catalog progress older than six hours is shown as delayed. Public status responses may be cached for 30 seconds; customer support endpoints remain private and uncached. No snapshot failure is converted to a successful health claim.

## Validation

`npm run test:commercial-experience` exercises authentication and staff gates, ownership isolation, idempotent ticket/reply submission, version conflicts, unread races, ten-request and reopening limits, conversation pagination, safe export projections, cascading erasure, public status freshness and incident overrides, immutable notice history, and bounded request retry/timeout behavior. It runs in the persistence and security workflows. Existing service, authentication, account export, account deletion, security and persistence regressions cover surrounding flows.

## Remaining launch work

These changes establish customer-service and recovery foundations; they do not certify every commercial launch dependency. Live payment and webhook configuration, verified transactional-email delivery and signup recovery, backup restoration drills, capacity tests, external paging coverage, and broad accessibility/device testing require independent verification. BioSync remains limited to recordings with verified exact-edition timing maps. Launch communications should reflect measured coverage and tested provider configuration.
