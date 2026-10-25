/* eslint-disable prettier/prettier -- Rights-scoped aggregate query and reporting safety gates remain together. */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const database = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const sql = [
  "SELECT m.country_code AS territory,",
  "(SELECT COUNT(*) FROM soundtrack_recordings r",
  " WHERE r.status='ready' AND r.quality_status='passed'",
  " AND r.storage_key IS NOT NULL AND r.source_snapshot_key IS NOT NULL",
  " AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(r.allowed_territories_json)",
  " THEN r.allowed_territories_json ELSE '[]' END) j",
  " WHERE j.value=m.country_code OR j.value='*')) AS commons_ready,",
  "(SELECT COUNT(*) FROM soundtrack_external_recordings e",
  " WHERE e.status='ready' AND e.storage_key IS NOT NULL",
  " AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(e.territories_json)",
  " THEN e.territories_json ELSE '[]' END) j",
  " WHERE j.value=m.country_code)) AS external_ready",
  "FROM storefront_markets m WHERE m.market_status='active' ORDER BY m.country_code",
].join(" ");
assert.match(sql.trim(), /^SELECT\b/);
assert.doesNotMatch(sql, /;|\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i);
function render(rows) {
  const out = [
    "# Cove Sounds: live rights-based market eligibility",
    "",
    "Read-only inventory assessment. Publication requires all six stations to contain a rights-checked recording and a purchasable book pairing; playback and retail still check canonical grants per request.",
    "",
    "| Active market | Ready Commons | Ready external | Eligibility |",
    "|:--|--:|--:|:--|",
  ];
  for (const row of rows) {
    assert.match(String(row.territory), /^[A-Z]{2}$/);
    const commons = Number(row.commons_ready);
    const external = Number(row.external_ready);
    assert.ok(Number.isSafeInteger(commons) && commons >= 0);
    assert.ok(Number.isSafeInteger(external) && external >= 0);
    const status = commons + external === 0 ? "No licensed inventory — fallback"
      : row.territory === "US" ? "Seeded US pilot (live authorization required)"
      : "Needs station-pairing and rights certification";
    out.push("| " + row.territory + " | " + commons + " | " + external + " | " + status + " |");
  }
  out.push("", "No rights may be inferred from a recording title or Creative Commons badge; a missing territory grant is a hard block. Data is aggregated; no buyer, session or track identifiers are printed.");
  return out.join("\n") + "\n";
}
if (process.argv.includes("--self-test")) {
  const example = render([{ territory:"US", commons_ready:206, external_ready:0 },
    { territory:"GB", commons_ready:0, external_ready:0 }]);
  assert.match(example, /GB \| 0 \| 0 \| No licensed inventory/);
  assert.match(example, /US \| 206 \| 0 \| Seeded US pilot/);
  console.log("PASS: licensed territorial inventory and non-US fallback status");
} else {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert.ok(token && token.length >= 10, "Cloudflare read-only reporting token missing");
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + account + "/d1/database/" + database + "/query",
    { method:"POST", headers:{ authorization:"Bearer " + token, "content-type":"application/json" },
      body:JSON.stringify({sql}), signal:AbortSignal.timeout(30_000) },
  );
  assert.ok(response.ok,"Cloudflare reporting request failed");
  const payload = await response.json();
  assert.ok(payload.success && payload.result?.[0]?.success, "Rights inventory read rejected");
  const summary = render(payload.result[0].results || []);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
}
