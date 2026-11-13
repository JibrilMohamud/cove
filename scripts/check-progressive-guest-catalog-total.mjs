import assert from "node:assert/strict";
import fs from "node:fs";

const search = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
const shortlist = fs.readFileSync("src/features/fore/search-popular-shortlist.server.ts", "utf8");
const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
const cache = fs.readFileSync("src/features/fore/public-api-cache.server.ts", "utf8");
const store = fs.readFileSync("src/features/fore/Store.tsx", "utf8");
const publicRights = fs.readFileSync("src/features/fore/rights-scoped-cache-page.ts", "utf8");

// Only this exact three-way opt-in can skip a foreground display COUNT.
// It still executes the real primary-D1 rights proof for a *25th* book.
assert.match(search, /FORE_GUEST_CATALOG_PROGRESSIVE_COUNT === "1"\s*&&\s*deferred !== undefined\s*&&\s*input\.limit === 24/);
assert.match(search, /FORE_POPULAR_RIGHTS_SHORTLIST === "1"\s*&&\s*!userId/);
assert.match(search, /input\.sort === "popular" &&\s*input\.page === 1/);
assert.match(search, /input\.subscription === undefined &&\s*input\.library === undefined/);
assert.match(search, /firstPagePopularRightsShortlist\(\s*env\.DB,\s*part,\s*progressive \? input\.limit \+ 1 : input\.limit/);
assert.match(search, /hasVerifiedNextPageWitness = progressive/);
assert.match(search, /verified\.slice\(0, input\.limit\)/);
assert.match(shortlist, /limit < 1 \|\| limit > 25/);
assert.match(shortlist, /rightsScopedCachedPageQuery\(scope, ids\)/);
assert.match(publicRights, /FROM selected wanted[\s\S]*CROSS JOIN catalog_search_documents d ON d\.product_id=wanted\.product_id/);

// If fewer than 25 verified books remain, the full ranking/COUNT path runs.
// A pending total is only a *lower bound*; all other use cases return exact
// totals, and every foreground search still hydrates primary D1 books.
assert.match(search, /const countPending = !!\(sharedFacets && facetState\.pending && hasVerifiedNextPageWitness\)/);
assert.match(search, /count = countPending\s*\? \{ count: input\.limit \+ 1 \}\s*: exact === null\s*\? await runCount\(\)/);
assert.match(search, /: countAvailableCandidatesFromFacet\(input, part\.hasFts, sharedFacets\)/);
assert.match(search, /const plan = await rankedCandidatePlan/);
assert.match(search, /const \[books, facets\] = await Promise\.all\(\[\s*canonicalBooksByProductIds\(env\.DB, ids\)/);
assert.match(search, /if \(!facetState\.pending\) \{[\s\S]*?await writeCatalogCache/);
assert.match(search, /countPending: "countPending" in result && result\.countPending === true/);
assert.match(api, /countPending: result\.countPending === true/);
assert.match(cache, /data\.facetsPending === true \|\| data\.countPending === true/);
assert.match(store, /countPending\?: boolean/);
assert.match(store, /query\.state\.data\?\.facetsPending \|\| query\.state\.data\?\.countPending \? 5_000 : false/);
assert.match(store, /disabled=\{!catalogDisplay\?\.next\}/);
assert.match(api, /input\.page \* result\.limit < result\.count/);

// Existing pricing, purchase, EPUB, legal-owner and entitlement read checks
// remain wholly outside the presentation-only count shortcut.
assert.doesNotMatch(shortlist, /\b(?:UPDATE|INSERT|DELETE)\s+/i);
assert.doesNotMatch(shortlist, /activeEntitlement|requireFullBookAccess|issueEntitlement/);

console.log("PASS: progressive guest total is a marked lower bound with verified Next, cross-colo exact facet completion, no shared pending cache, and live rights/fallback intact");
