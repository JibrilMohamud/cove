import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const entry = readFileSync("src/persistence-backend.worker.ts", "utf8");

test("the Worker entrypoint has no unreviewed console call sites", () => {
  const sites = entry.match(/console\.(?:warn|error|info|log|debug)\(/g) ?? [];
  assert.equal(sites.length, 31, "New Worker logs require explicit privacy review");
});

test("Worker logs exclude raw exceptions, media IDs and potentially private queue results", () => {
  for (const unsafe of [
    'console.warn("Catalog search sync failed", error)',
    'console.warn("Unable to persist Cove audio trigger diagnostic", error)',
    'console.error("Cove scheduled queue failed", name, error)',
    'console.info("Cove BioSync short-track transcript cached", row.edition_id',
    'console.warn("Cove minute maintenance failed", String(error)',
    'console.error("Cove scheduled BioSync trigger failed", result.reason)',
    'console.error("Cove scheduled audio trigger failed", result.reason)',
    'console.warn("Cove published soundtrack rights audit", JSON.stringify(rights))',
    'console.info("Cove soundtrack R2 import", JSON.stringify(result))',
    'console.error("Hosted BioSync transcription failed", editionId',
    'console.error("Community tournament advancement failed", error)',
    'console.error("Cove scheduled ingestion failed", controller.cron, error)',
    'console.error("Regional EPUB repair failed", String(error)',
    'console.info(JSON.stringify({ event: "account_erasure_tick", ...result }))',
  ]) {
    assert.equal(entry.includes(unsafe), false, "Sensitive log payload: " + unsafe);
  }
});

test("retained scheduled diagnostic signals contain only bounded operational fields", () => {
  assert.match(
    entry,
    /console\.info\(JSON\.stringify\(\{ event: "account_erasure_tick", completed: true \}\)\)/,
  );
  assert.match(
    entry,
    /console\.info\(JSON\.stringify\(\{ event: "cove_queue_tick", name, completed: true \}\)\)/,
  );
  assert.match(entry, /console\.warn\("Cove published soundtrack rights audit"\)/);
  assert.match(entry, /console\.error\("Cove scheduled queue failed", name\)/);
  assert.doesNotMatch(entry, /console\.(?:info|warn|error)\([^\n]*String\(error\)/);
});
