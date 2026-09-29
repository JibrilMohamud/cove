# Cove on Vercel

This checkout now emits a Nitro Vercel build when the `VERCEL` environment variable is present. The original Cloudflare/Sites staging path remains unchanged for non-Vercel builds.

## Important runtime boundary

Cove's commercial API still uses Cloudflare-style `DB` (D1) and `BUCKET` (R2) bindings. Vercel does not provide those bindings automatically. The app can be built and served on Vercel, and `/api/fore/health/live` remains usable, but database-backed catalog, account, commerce, publishing, sync, and object-storage flows require either:

1. a compatibility adapter to a Vercel-accessible database/object store, or
2. proxying `/api/fore/*` to the existing Cloudflare Worker that owns D1/R2.

Do not set Cloudflare credentials in client-visible `VITE_*` variables. Server secrets belong in Vercel environment variables only.
