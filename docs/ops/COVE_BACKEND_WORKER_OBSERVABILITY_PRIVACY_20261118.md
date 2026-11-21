# Cove production backend: privacy-safe observability preflight (2026-11-18)

**Status: draft source hardening only; NOT authorized to enable or deploy production logs.**

## Why this is necessary

A read-only Cloudflare Workers Observability query found 12 recorded `cove-persistence-backend` events in November 13–15 but no recorded backend events in the November 15–18 (05:45 UTC) window. Vercel nonetheless recorded a real production `/api/fore/storefront/bootstrap` fail-closed 503 at 05:10 UTC November 18. This mismatch is **missing diagnostic evidence**, not proof that Cloudflare did not receive requests.

Cloudflare Workers Logs may persist invocation data, uncaught exceptions and console messages. Cove's backend entrypoint previously logged raw exception objects, error strings, audio edition and track identifiers, potentially identifying soundtrack rights payloads, queue operation return objects, and account-deletion results. It also copied up to 900 characters of an upstream Vercel error response body into a D1 runtime diagnostic. These are unacceptable defaults if logs are enabled or diagnostics are later exported.

## Source-only mitigation in this PR

- The Worker entrypoint's 31 `console` sites now use fixed strings, an explicitly reviewable two-literal D1 quota outcome, or **two** bounded-count templates only. No raw exception objects, response bodies, edition/track IDs, queue/rights/account results, cron strings or other user/provider-controlled objects enter these console arguments.
- Audio-trigger D1 status receipts retain the existing trusted internal path, HTTP status and fixed `in-flight` disposition. They **no longer read or persist arbitrary non-2xx Vercel response body text**. D1 queries, queue operations, gate decisions, rights checks, retry behavior, error responses and customer routing stay unchanged.
- New credential-free PR CI parses the TypeScript syntax tree, enforces each console call's single reviewed safe argument, checks all three audio status receipts' exact property/value allowlist, and proves negative unsafe mutations fail. The Worker logging inventory is pinned to 31 sites for re-review if edited.
- The same test verifies that `wrangler.backend.production.toml` has no `[observability]` setting. Production collection must **not** be turned on merely because one source file is clean.

## Explicit remaining limits

This review covers **only** `src/persistence-backend.worker.ts` and those three D1 audio diagnostic writes. It does not certify `src/features/fore/api.server.ts`, imported catalog/audio/commerce/rights modules, third-party SDKs, exception propagation, Cloudflare invocation metadata or request URL/headers. Before opt-in to Workers Logs, audit or disable sensitive invocation logs, audit imported modules and exception reporting, choose minimal head sampling/retention, and prove sanitized output in an isolated protected Worker. Any new run must not change production D1 bindings, legal-owner configuration or live customer routes.

The existing source still has protected direct D1 bindings and owner-required SQL; no code or test in this PR grants production mutation authority. This work cannot certify storefront 503 elimination, strict performance, paid transaction and revocation, physical writer exclusivity, or protected rollback. Mandatory dependency-security audit stays unchanged and must pass before merge.

**Release gate: NO-GO.**
