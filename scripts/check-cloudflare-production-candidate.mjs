import assert from "node:assert/strict";
import fs from "node:fs";

const stage = fs.readFileSync("wrangler.frontend.staging.toml", "utf8");
const production = fs.readFileSync("wrangler.frontend.production.toml", "utf8");
const gate = fs.readFileSync("docs/performance/cloudflare-commercial-cutover-gate.md", "utf8");

// Cloudflare assigns Worker scripts at
// <script>.<account-subdomain>.workers.dev, never the account root.
assert.match(production, /^name = "cove"$/m);
assert.match(production, /^FORE_PUBLIC_URL = "https:\/\/cove\.cove-jibrilmohamud\.workers\.dev"$/m);
assert.doesNotMatch(
  production,
  /^FORE_PUBLIC_URL = "https?:\\/\\/cove-jibrilmohamud\\.workers\\.dev"$/m,
);
assert.doesNotMatch(production, /cove-puce-theta\.vercel\.app/);

// A committed, unreviewed deployment must NEVER silently open a new
// storefront before the manual security/payment/customer-journey gate.
assert.match(production, /^workers_dev = false$/m);
assert.doesNotMatch(production, /^routes?\s*=/m);
assert.doesNotMatch(production, /^\[\[routes\]\]/m);
assert.doesNotMatch(production, /^COVE_SSR_STAGING\s*=/m);
assert.doesNotMatch(production, /\b(sk_live_|rk_live_|whsec_|SUPABASE_SERVICE_ROLE_KEY)\b/);
assert.match(production, /^FORE_AUTH_MODE = "supabase"$/m);
assert.match(production, /^FORE_ENVIRONMENT = "production"$/m);
assert.match(production, /^main = "\.output\/server\/index\.mjs"$/m);
assert.match(production, /^run_worker_first = true$/m);
assert.match(production, /^binding = "ASSETS"$/m);
for (const name of ['binding = "DB"', 'binding = "BUCKET"', 'name = "COVE_STOREFRONT_READ_LIMITER"'])
  assert.ok(production.includes(name), "Missing native binding " + name);
assert.match(production, /^database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989"$/m);
assert.match(production, /^bucket_name = "cove-production-media"$/m);
assert.match(stage, /^workers_dev = true$/m);
assert.match(stage, /^COVE_SSR_STAGING = "1"$/m);
assert.doesNotMatch(production, /^COVE_SSR_STAGING_GATE_KEY/im);
assert.match(gate, /DO NOT ROUTE CUSTOMERS TO CLOUDFLARE YET/);
assert.match(gate, /Supabase/);
assert.match(gate, /Stripe/);
assert.match(gate, /offline/);
console.log(
  "PASS: production candidate is unroutable, canonical HTTPS Worker URL correct; D1/R2/assets configuration present, release gate still blocks public traffic.",
);
