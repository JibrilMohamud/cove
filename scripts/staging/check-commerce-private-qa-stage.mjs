import assert from "node:assert/strict";
import fs from "node:fs";

const text = fs.readFileSync("wrangler.commerce-qa.stage.toml", "utf8");
const includes = [
  'name = "cove-commerce-customer-qa-stage"',
  'account_id = "f51e8ccbc394e2d6016ff8c2c303d54b"',
  "workers_dev = false",
  "preview_urls = false",
  'binding = "DB"',
  'database_id = "f9354381-bd9f-496b-bd05-d6f62a32ec0c"',
  'binding = "BUCKET"',
  'bucket_name = "cove-commerce-detached-media-qa"',
  'COVE_SSR_STAGING = "1"',
  'FORE_AUTH_MODE = "supabase"',
  'STRIPE_LIVEMODE = "false"',
  'STRIPE_TAX_ENABLED = "false"',
];
for (const line of includes)
  assert.ok(text.includes(line), "Full-commerce QA isolation invariant missing: " + line);
assert.doesNotMatch(text, /4bd657ac-8789-403e-a28c-93aba8d0a989/);
assert.doesNotMatch(text, /cove-production-media|cove-production|STRIPE_LIVEMODE\s*=\s*"true"/);
assert.doesNotMatch(
  text,
  /^\s*(?:route|routes)\s*=|^\s*workers_dev\s*=\s*true|^\s*preview_urls\s*=\s*true/m,
);
assert.doesNotMatch(text, /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/);
console.log(
  "PASS: original media and customer D1 isolated; unpublished gated stage; TEST-only billing mode.",
);
