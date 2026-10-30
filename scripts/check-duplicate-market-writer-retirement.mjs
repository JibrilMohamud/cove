/* eslint-disable prettier/prettier -- Exact duplicate authorizing writer retirement invariant. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const canonical=readFileSync("src/features/fore/localization.server.ts","utf8");
const optimized=readFileSync("src/storefront-strangler/localization-optimized.server.ts","utf8");
const registry=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
const exact='export { upsertMarket } from "../features/fore/localization.server";';
assert.equal(optimized.split(exact).length-1,1,"The optimized storefront MUST export the original canonical market writer, not another SQL copy");
assert.match(canonical,/export async function upsertMarket\(/,"Canonical market admin behavior must remain callable");
assert.match(canonical,/INSERT INTO storefront_markets\(/,"Canonical market SQL must remain fully auditable");
assert.doesNotMatch(optimized,/INSERT INTO storefront_markets\(/,"The duplicate canonical market writer must remain retired");
const original=registry.sites.filter(s=>s.file==="src/features/fore/localization.server.ts"&&s.commandFamily==="localization.upsertMarket");
assert.equal(original.length,1,"The sole original market writer remains owner-required");
assert.equal(original[0].disposition,"owner-command-required");
assert.equal(registry.sites.filter(s=>s.file==="src/storefront-strangler/localization-optimized.server.ts"&&s.commandFamily==="localization-optimized.upsertMarket").length,0);
const ownerRequired=registry.sites.filter(s=>s.disposition==="owner-command-required").length;
assert.ok(ownerRequired>0&&ownerRequired<=370,
  "Verified SQL retirements may reduce the count; exact source inventory and frozen exceptions independently prevent laundering");
console.log("PASS: duplicate optimized writer removed, original canonical behavior and owner-required SQL remain; one market writer physically retired, "+ownerRequired+" owner-required sites still block release.");
