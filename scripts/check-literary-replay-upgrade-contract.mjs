import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync("src/lib/literary-legacy-reconcile.server.ts", "utf8");
const outbox = readFileSync("src/lib/literary-prepare-outbox.server.ts", "utf8");
assert.ok(source.includes('owner?.value !== "isolated"'));
assert.ok(source.includes('afterSeedOwner?.value !== currentOwner.value'));
assert.ok(outbox.includes('"draining" | "isolated"'));
console.log("LITERARY_REPLAY_UPGRADE_GUARDS_PASS");
