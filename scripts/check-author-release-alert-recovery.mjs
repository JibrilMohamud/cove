import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/features/fore/retail-intelligence.server.ts", "utf8");
const start = source.indexOf("export async function processAuthorReleaseAlerts(");
const end = source.indexOf("export async function publisherAuthorProfiles(", start);
assert.ok(start >= 0 && end > start, "Missing author-release alert executor");
const code = source.slice(start, end);

// Crash recovery must reclaim stale PROCESSING rows and must not steal a
// healthy lease or starve newly pending jobs.
assert.match(code, /Date\.now\(\) - 30 \* 60_000/);
assert.match(code, /status='pending' AND available_at<=\?/);
assert.match(code, /status='processing' AND updated_at<=\?/);
assert.match(code, /ORDER BY available_at LIMIT \?/);

// A single atomic CAS is the only allowed lease acquisition. Another runner
// may select the same row, but must not emit notifications without a claim.
assert.match(
  code,
  /UPDATE author_release_alert_jobs SET status='processing',attempts=attempts\+1,updated_at=\?/,
);
assert.match(code, /status='processing' AND updated_at<=\?\)\) RETURNING attempts/);
assert.match(code, /\.first<\{ attempts: number \}>\(\)/);
assert.match(code, /if \(!claimed\) continue/);
assert.match(code, /processed\+\+/);
assert.doesNotMatch(code, /\bprocessed: jobs\.results\.length\b/);

// Every completion, page checkpoint and error must be fenced to the exact
// lease generation. Stale runners cannot clear a later runner's progress.
const leaseFences = code.match(/AND status='processing' AND updated_at=\?/g) || [];
assert.equal(leaseFences.length, 3);
assert.match(code, /\.bind\(cursor, at, now\(\), job\.id, claimAt\)/);
assert.match(code, /\.bind\(now\(\), job\.id, claimAt\)/);
assert.match(code, /\.bind\(status, retry, now\(\), job\.id, claimAt\)/);
assert.match(code, /Number\(claimed\.attempts\)/);
assert.doesNotMatch(code, /Number\(job\.attempts \|\| 0\) \+ 1/);

// Per-follower dedupe is necessary for safe delivery replay after a crash.
assert.match(code, /dedupeKey: key/);
assert.match(code, /emitNotification\(db,/);
assert.match(code, /return \{ processed, notifications \}/);

console.log(
  "PASS: crashed author-release alert leases are recoverable and all updates are generation-fenced.",
);
