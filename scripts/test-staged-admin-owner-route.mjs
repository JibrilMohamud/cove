import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-level reachability guard accompanies the functional owner-first
// RPC tests. No standalone public SQL endpoint may be created by this slice.
const source = readFileSync("src/features/fore/api.server.ts", "utf8");
const env = readFileSync("wrangler.frontend.production.toml", "utf8");
const start = source.indexOf('if (path.startsWith("/admin/commerce/"))');
const auth = source.indexOf("await requireCommerceAdmin(request, env, commercePermission)", start);
const route = source.indexOf('path === "/admin/commerce/legal-owner-command"', auth);
assert.ok(
  start > 0 && auth > start && route > auth && route - auth < 2200,
  "Only authenticated commerce administrators may reach the owner command",
);
const nextRoute = source.indexOf('path === "/admin/commerce/rights-party"', route);
assert.ok(nextRoute > route && nextRoute - route < 1100,
  "Commerce owner command must remain a small authenticated route, not a bypass");
assert.match(source.slice(auth, nextRoute), /executeStageCanonicalAdminCommand/);
assert.match(source.slice(route, nextRoute), /command.action === "withdraw-distribution"/,
  "Commerce administrators must not spoof publishing distribution withdrawals");
assert.match(source, /executeStageRightsEditorSuspension\(env, "grant", input\)/);
assert.match(source, /executeStageRightsEditorSuspension\(env, "contract", input\)/);
const lockedStagingPattern =
  /env\.COVE_SSR_STAGING === "1" \|\| env\.COVE_CANONICAL_LEGAL_WRITE_LOCK === "1"/g;
assert.equal(
  [...source.matchAll(lockedStagingPattern)].length,
  2,
  "Both legacy rights editors must deny raw D1 in isolated locked staging",
);
assert.equal(
  (source.match(/Staging rights edits require verified owner-first commands/g) || []).length,
  2,
  "Missing ownerAction may never silently fall through to legacy SQL",
);
assert.doesNotMatch(
  env,
  /LEGAL_QUARANTINE_WRITER|COVE_LEGAL_QUARANTINE_SECRET|COVE_LEGAL_WRITER_PRIMARY_ID/,
  "Production frontend must never inherit an isolated QA writer binding",
);
console.log(
  "PASS: scoped owner RPC is behind verified commerce staff authorization, editor suspensions are owner-first and production has no QA writer",
);
