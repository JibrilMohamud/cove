# Ingress-edge vs Smart Placement SSR experiment — 2026-10-25

## Hypothesis

The storefront Worker must perform a fresh primary-D1 rights check before a 24-book SSR homepage may be returned. Stage Smart Placement helped median Worker CPU/database timings, but under real IAD (US rights) ingress its strict three independently cold-deployed rounds failed 3/3. Many failing requests spent only ~130–170 ms **inside** the Worker and 500–800 ms **outside** timed execution. Cloudflare's platform documents that Smart Placement may forward requests away from their entry colo and that `run_worker_first=true` makes assets traverse that placement too. The unpublished production candidate currently has no Smart Placement override.

## Controlled change

Remove **only** the `[placement] mode="smart"` stage override. Preserve:
- exact existing primary D1, R2, 24 independently rights-authorized US books
- edge rate limit, fail-closed ephemeral staging bearer, no-store SSR
- same Nitro binary, hosted Cloudflare Workers.dev, same bundled assets and `run_worker_first=true`
- same 3 freshly deployed secret generations, genuine **first** cold request and 20/20 strict maximum below 800 ms
- identical locales, mobile 4G Chromium/LCP measurement, and 1/4/8/16 in-flight full catalog comparison
- 401 unauthenticated controls and anti-spoofed-country checks

## Acceptance and confounders

Source baseline: [Smart Placement US-licensed staging 40178223448](https://github.com/JibrilMohamud/cove/actions/runs/40178223448), attempt 2. IAD ingress, 24 cards, cold rounds: 2/20 slow (max 879 ms), 3/20 slow (max 977 ms), 3/20 slow (max 1004 ms). Desktop LCP p75 792 ms; mobile 4G LCP p75 1632 ms. On late browser samples the primary D1 service itself also intermittently reached ~1–1.6 seconds, which turning placement off may exacerbate. **No win is assumed.**

The edge test requires a genuine licensed **US Cloudflare ingress**; changing `x-cove-client-country`, `cf-ipcountry` or Vercel country headers to manufacture US samples is forbidden. When a runner enters through a country with no grants, the measurement is inconclusive and the release gate must fail. Record actual colo, worker duration, client sent-to-headers and authorized SSR cards. Lower p75 is insufficient if any sample >=800 ms, a full 24-book shelf disappears, browser LCP fails, or a rights/auth/commerce regression appears.

Do not update the pinned Vercel alias, production gateways, custom domain or production Worker until separate release certification passes.
