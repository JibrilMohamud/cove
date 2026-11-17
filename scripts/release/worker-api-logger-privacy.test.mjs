import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The production persistence Worker imports api.server.ts. Reviewing only the
// Worker entrypoint misses log payloads from this substantial imported module.
const api = readFileSync("src/features/fore/api.server.ts", "utf8");

test("all imported API logger sites have only an approved static event message", () => {
  const callSites = [...api.matchAll(/console\\.(?:warn|error|info|log|debug)\\s*\\(/g)];
  const approvedCalls = [
    ...api.matchAll(
      /console\\.(?:warn|error|info|log|debug)\\s*\\(\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')\\s*\\)/g,
    ),
  ];
  const allowedMessages = [
    "Cache write unavailable",
    "Initial search index sync failed",
    "Commercial catalog search failed closed",
    "Catalog asset maintenance failed",
    "Regional search sync failed",
    "Catalog search sync failed",
    "Reading Journey generation failed",
    "Annotation version anchor snapshot failed",
    "Cove service error; request failed closed",
  ];
  assert.equal(callSites.length, allowedMessages.length, "Unexpected API logging site: review privacy first");
  assert.equal(approvedCalls.length, callSites.length, "Raw exception, user value or structured payload in a log");
  const seenMessages = approvedCalls.map((m) => JSON.parse(m[1]));
  assert.deepEqual(seenMessages.sort(), allowedMessages.sort());
});

test("fail-closed 503 and user-visible error handling stay intact", () => {
  assert.match(
    api,
    /console\\.warn\\("Commercial catalog search failed closed"\\);[\\s\\S]{0,120}throw new ApiError\\(\\s*503/,
  );
  assert.match(api, /console\\.error\\("Cove service error; request failed closed"\\);/);
  assert.match(api, /"This content could not be loaded\\. Please try again\\."/);
});
