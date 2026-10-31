/* eslint-disable prettier/prettier -- Exact duplicate authorizing writer retirement invariant. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const canonical=readFileSync("src/features/fore/localization.server.ts","utf8");
const optimized=readFileSync("src/storefront-strangler/localization-optimized.server.ts","utf8");
const registry=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
const exact='export { upsertMarket } from "../features/fore/localization.server";';
assert.equal(optimized.split(exact).length-1,1,"The optimized storefront MUST export the original canonical market writer, not another SQL copy");
assert.match(canonical,/export async function upsertMarket\(/,"Canonical market admin behavior must remain callable");
assert.doesNotMatch(canonical,/INSERT INTO storefront_markets\(/,"Canonical shared market SQL must stay retired");
const privateOwner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
assert.match(privateOwner,/if\(route==="\/market\/private-admin-upsert"\)/);
assert.match(privateOwner,/INSERT INTO storefront_markets\(/,"The private owner must retain the exact canonical market mutation");
assert.doesNotMatch(optimized,/INSERT INTO storefront_markets\(/,"The duplicate canonical market writer must remain retired");
const original=registry.sites.filter(s=>s.file==="src/features/fore/localization.server.ts"&&s.commandFamily==="localization.upsertMarket");
assert.equal(original.length,0,"No shared market writer may reappear after private-owner retirement");
const lineage=JSON.parse(readFileSync("docs/architecture/retired-private-market-admin-owner-lineage.json","utf8"));
assert.equal(lineage.retired.length,1);
assert.equal(lineage.retired[0].commandFamily,"localization.upsertMarket");
assert.equal(registry.sites.filter(s=>s.file==="src/storefront-strangler/localization-optimized.server.ts"&&s.commandFamily==="localization-optimized.upsertMarket").length,0);
const ownerRequired=registry.sites.filter(s=>s.disposition==="owner-command-required").length;
assert.ok(ownerRequired>0&&ownerRequired<=370,
  "Verified SQL retirements may reduce the count; exact source inventory and frozen exceptions independently prevent laundering");
console.log("PASS: duplicate optimized writer removed, private owner retains canonical behavior and shared SQL stays retired; one market writer physically retired, "+ownerRequired+" owner-required sites still block release.");
