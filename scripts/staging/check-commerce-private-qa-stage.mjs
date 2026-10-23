import assert from "node:assert/strict";
import fs from "node:fs";

const text = fs.readFileSync("wrangler.commerce-qa.stage.toml", "utf8");
const includes = [
  'name = "cove-commerce-customer-qa-stage"',
  'workers_dev = false',
  'preview_urls = false',
  'binding = "DB"',
  'database_id = "5be15110-44a6-4090-b0a1-36599d809b28"',
  'binding = "BUCKET"',
  'bucket_name = "cove-commerce-original-media-qa-20261022"',
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
console.log("PASS: original media and customer D1 isolated; unpublished gated stage; TEST-only billing mode.");
