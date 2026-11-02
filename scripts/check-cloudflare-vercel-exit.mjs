import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(file, "utf8");
const backend = read("wrangler.backend.production.toml");
const frontend = read("wrangler.frontend.production.toml");
const shadow = JSON.parse(read("wrangler.storefront-strangler.production-shadow.jsonc"));
const backendDeploy = read(".github/workflows/deploy-persistence-backend.yml");
const audio = read("scripts/audio_pipeline/service.py");
const vercel = JSON.parse(read("vercel.json"));

assert.match(backend, /^FORE_PUBLIC_URL = "https:\/\/www\.covereads\.com"$/m);
assert.match(frontend, /^FORE_PUBLIC_URL = "https:\/\/www\.covereads\.com"$/m);
assert.equal(shadow.vars.FORE_PUBLIC_URL, "https://www.covereads.com");
assert.doesNotMatch(backend, /https:\/\/[a-z0-9-]+\.vercel\.app/i);
assert.doesNotMatch(frontend, /https:\/\/[a-z0-9-]+\.vercel\.app/i);
assert.doesNotMatch(backendDeploy, /https:\/\/[a-z0-9-]+\.vercel\.app/i);
assert.match(backendDeploy, /^  workflow_dispatch:$/m);
assert.doesNotMatch(backendDeploy, /^  push:$/m);
assert.match(backendDeploy, /default: "https:\/\/www\.covereads\.com"/);
assert.match(backendDeploy, /github\.ref == 'refs\/heads\/main'/);
assert.match(frontend, /^workers_dev = false$/m);
assert.match(frontend, /^preview_urls = false$/m);
assert.match(frontend, /^COVE_CANONICAL_READONLY_RPC = "1"$/m);
assert.match(frontend, /^binding = "COVE_CANONICAL_READONLY"$/m);
assert.match(frontend, /^service = "cove-canonical-d1-readonly"$/m);
assert.doesNotMatch(frontend, /^\[\[d1_databases\]\]$|^binding = "DB"$|^database_id\s*=/m);
assert.doesNotMatch(frontend, /^\[\[routes\]\]|^route\s*=|^routes\s*=/m);
assert.equal(shadow.vars.COVE_STRANGLER_RELEASE_CERTIFIED, "0");
assert.equal(vercel.services?.app?.framework, "tanstack-start");

const stillUsesVercelAudio =
  vercel.services?.audio_pipeline?.framework === "fastapi" ||
  audio.includes("from vercel.queue import QueueClient");

console.log("PASS: production config uses www.covereads.com and backend deploy cannot automatically run.");
console.log("PASS: Cloudflare frontend is route-free and D1-read-only; shadow is release-disabled.");
if (stillUsesVercelAudio) {
  console.log("BLOCKED: Vercel FastAPI and Vercel Queues are still required for audio processing.");
}
console.log("BLOCKED: no production legal-owner, exclusive-D1, Stripe LIVE, geographic performance or protected rollback certificate is supplied by this source audit.");
if (process.argv.includes("--require-complete")) {
  throw Error("Vercel shutdown is NOT certified. Never change DNS or delete Vercel based on this audit.");
}
