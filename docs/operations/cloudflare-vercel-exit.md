# Cove: migration off Vercel — NOT YET CERTIFIED

## Actual infrastructure, independently inspected 2026-11-02

- The Cloudflare zone for covereads.com is active, but apex and www DNS CNAMEs still point to Vercel. Do not modify them before release acceptance.
- api.covereads.com already routes to the cove-persistence-backend Cloudflare Worker. This Worker still has a native production canonical D1 binding.
- cove-legal-authority-production has COVE_RIGHTS_OWNER_ENABLED=0 and is not a certified production authority.
- The proposed cove production SSR Worker is not deployed. Its wrangler.frontend.production.toml has no public routes, workers_dev=false, preview_urls=false and **no native production D1 binding**. It uses the private cove-canonical-d1-readonly service plus COVE_CANONICAL_READONLY_RPC=1, so public SSR cannot acquire a canonical D1 write capability.
- FastAPI audio processing still runs on Vercel. scripts/audio_pipeline/service.py uses Vercel Queues, and subscriber.py consumes those jobs. Simply moving HTML/SSR to Cloudflare does not complete the migration.
- Frontend production secrets, customer payment entitlement/revocation, multi-geographic performance and protected rollback are not independently certified.

## Completed precursor changes

- The persistence/backend release default and the dormant customer gateway use the stable Cove-owned HTTPS origin https://www.covereads.com, not a Vercel deployment hostname. The domain currently resolves to Vercel and is intended to resolve to Cloudflare after cutover.
- scripts/check-cloudflare-vercel-exit.mjs rejects Vercel-hosted production origin configuration and explicitly reports the remaining Vercel audio service.
- cloudflare-vercel-exit-precutover.yml builds the actual SSR/static bundle and dry-runs Cloudflare on PRs. A manual main-only job can stage an unroutable candidate only when the account has approved the protected environment, set COVE_CLOUDFLARE_PRECUTOVER_APPROVED=1 and provisioned a scoped CLOUDFLARE_COVE_PRODUCTION_FRONTEND_DEPLOY_TOKEN. Do not configure these until independent review. No DNS mutation occurs.

## Hard, independently evidenced migration gates

1. Replace the FastAPI + Vercel Queues audio producer/subscriber with Cloudflare Queues plus a suitable Python/media runtime such as Cloudflare Containers, or another specifically chosen non-Vercel provider. Preserve idempotency, DLQs, retry/timeout and media caches; certify BioSync, alignment, original publication, payment-related rights and recovery. Do not silently remove audio or count paused compute as a complete migration.
2. Certify an independent production rights/legal owner with authentic contracts, territories, positive tax proof and revocation. Remove every competing D1 canonical writer, keeping all restrictions fail-closed.
3. Install and independently attest least-privilege Cloudflare deployment/runtime secrets. Test Supabase login, signup, OAuth/email callbacks and cookies on www.covereads.com; verify CSP, CORS, PWA service worker, cart and cart redirects, public/community posting, static assets, private delivery, offline license and account deletion.
4. Prove real Stripe LIVE payment/webhook delivery, settlement, entitlement issuance, protected EPUB/audio access, refund and immediate revocation. Do not repoint or activate LIVE payment flows before the customer journey is certified.
5. Deploy the exact reviewed Cloudflare frontend bundle unroutably; independently verify Worker deployment/config and secrets, with zero customer traffic.
6. Pass strict geographic repeatability ORD/LAX/IAD/DFW, three independently cold versions and 1/4/8/16/32 hosted concurrency (all TTFB strictly under 800 ms), followed by two full 20-second 100-RPS phases (2,000 valid responses each, p95 under 600 ms, p99 under 750 ms, max under 800 ms, zero drops).
7. Rehearse authenticated session, Stripe, entitlement, protected media and rights-withdrawal rollback in both directions. Keep Vercel intact through the rehearsal.
8. Only after independent release approval: attach Cloudflare to the intended www/apex hostnames; validate DNS, TLS, cookies, redirects, Stripe signature verification and response origin. Watch production performance, errors, refunds, customer rights and revocation during a soak period, with documented stop/rollback conditions.
9. After all request paths and Vercel audio consumers are retired, disable Vercel Git deployments and delete the Vercel project and Vercel queues through the platform, preserving an approved backup.

Do not change customer DNS, enable the QA-only legal owner, revoke active credentials, run uncertified LIVE payments, or delete Vercel solely because the static Cloudflare build succeeds.
