/**
 * ISOLATED SYNTHETIC D1 ONLY, READ-ONLY, NO PRODUCTION WRITES.
 *
 * Differentially compare Cove's ACTUAL resolveProductRights() decision with
 * the stage D1's retail_product_availability_rows view, under the SAME
 * territory, format, time and retail channel. The view currently predates
 * parts of canonical contract-version logic: disagreeing rows must block
 * a positive-writer release until all policy gaps are reconciled.
 *
 * Outputs only aggregate counts and generic reason classes, not product IDs,
 * legal terms, rightsholder data, SQL, credentials or selected API keys.
 */
import assert from "node:assert/strict";
import { assertSyntheticRightsDifferentialCoverage } from "./rights-differential-coverage.mjs";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const DATABASE = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`;
const BUDGET = 48;
const RETAIL_VIEW = `SELECT EXISTS(
  SELECT 1 FROM retail_product_availability_rows a
  WHERE a.product_id=? AND a.territory_code=?
) AS permitted`;

const TOKEN = process.env.COVE_CF_STAGE_D1_READ_TOKEN;
const MAX_READ_QUERIES = 1400;
const READ_PACE_MS = 75;
if (
  process.env.COVE_SYNTHETIC_OWNER_DIFF_ONLY !== "1" ||
  !TOKEN ||
  TOKEN.length < 20 ||
  process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT ||
  process.env.COVE_SYNTHETIC_D1_ID !== DATABASE
)
  throw new Error("Explicit read-only synthetic D1 legal comparison not authorized");

let queryCount = 0;
async function readOnlySql(sql, params = []) {
  // SQL has no writable verbs or multiple statements; don't run .run/batch.
  if (
    !/^\s*(SELECT|WITH)\b/i.test(sql) ||
    /;/.test(sql) ||
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i.test(sql)
  )
    throw new Error("Write-capable or multi-statement SQL is forbidden");
  queryCount += 1;
  if (queryCount > MAX_READ_QUERIES)
    throw new Error("Synthetic D1 rights comparison request budget exhausted");
  // Global pacing is deliberate: this is an audit, not production load.
  await new Promise((resolve) => setTimeout(resolve, READ_PACE_MS));
  const response = await fetch(API, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("Synthetic D1 read query HTTP failure " + response.status);
  const data = await response.json();
  if (!data.success || !Array.isArray(data.result?.[0]?.results))
    throw new Error("Synthetic D1 read query failed; safe-stop, no retries");
  const meta = data.result[0].meta;
  if (meta?.changed_db === true || Number(meta?.changes || 0) !== 0)
    throw new Error("Unexpected mutation response in read-only D1 comparison");
  return data.result[0].results;
}
const prepare = (sql, values = []) => ({
  bind: (...newValues) => prepare(sql, newValues),
  first: async () => (await readOnlySql(sql, values))[0] || null,
  all: async () => ({ results: await readOnlySql(sql, values) }),
  run: async () => {
    throw new Error("Read-only canonical rights adapter prohibits mutations");
  },
});
const db = {
  prepare: (sql) => prepare(sql),
  batch: async () => {
    throw new Error("Read-only canonical rights adapter prohibits D1 batches");
  },
};
const tmp = mkdtempSync(path.join(tmpdir(), "cove-stage-real-rights-diff-"));
try {
  const outfile = path.join(tmp, "rights.mjs");
  await build({
    entryPoints: ["src/features/fore/rights.server.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { resolveProductRights } = await import(pathToFileURL(outfile).href);
  assert.equal(typeof resolveProductRights, "function");


  // Prior 48 matches were 24 positive and 24 EXPLICIT_DENY only. That
  // cannot certify contract versions, scoped languages, DRM or timed rights.
  // Prioritize independent bounded policy cohorts, keeping all source data
  // and IDs private and restricting evaluation to the isolated synthetic D1.
  const cohorts=[
    {name:"contract_version",limit:12,sql:`
      SELECT DISTINCT p.id product_id FROM products p
      JOIN rights_grants rg ON rg.edition_id=p.edition_id
      JOIN rights_contract_versions v ON v.contract_id=rg.contract_id
      WHERE p.id LIKE 'perf-synth-%' ORDER BY p.id LIMIT 12`},
    {name:"contract_language",limit:12,sql:`
      SELECT DISTINCT p.id product_id FROM products p
      JOIN rights_grants rg ON rg.edition_id=p.edition_id
      JOIN rights_contract_languages l ON l.contract_id=rg.contract_id
      WHERE p.id LIKE 'perf-synth-%' ORDER BY p.id LIMIT 12`},
    {name:"nontrivial_drm",limit:12,sql:`
      SELECT DISTINCT p.id product_id FROM products p
      JOIN rights_grants rg ON rg.edition_id=p.edition_id
      WHERE p.id LIKE 'perf-synth-%'
        AND lower(COALESCE(rg.drm_requirement,'')) NOT IN ('none','optional','any','')
      ORDER BY p.id LIMIT 12`},
    {name:"contract_bound",limit:12,sql:`
      SELECT DISTINCT p.id product_id FROM products p
      JOIN rights_grants rg ON rg.edition_id=p.edition_id
      WHERE p.id LIKE 'perf-synth-%' AND rg.contract_id IS NOT NULL
      ORDER BY p.id LIMIT 12`},
    {name:"explicit_deny",limit:24,sql:`
      SELECT DISTINCT p.id product_id FROM products p
      JOIN rights_grants rg ON rg.edition_id=p.edition_id
      WHERE p.id LIKE 'perf-synth-%' AND rg.decision='deny'
      ORDER BY p.id LIMIT 24`},
    {name:"ranked",limit:24,sql:`
      SELECT product_id FROM catalog_search_documents
      WHERE product_id LIKE 'perf-synth-%'
      ORDER BY fore_bestseller_score DESC,external_book_id ASC,product_id ASC LIMIT 24`},
  ];
  const selected=new Set(),coverage=Object.create(null);
  for(const cohort of cohorts){
    const rows=await readOnlySql(cohort.sql);
    if(rows.length>cohort.limit)throw Error("Unbounded isolated legal witness group");
    let added=0;
    for(const row of rows){
      const id=String(row.product_id||"");
      if(!/^perf-synth-[A-Za-z0-9_-]{1,120}$/.test(id))
        throw Error("Unapproved legal witness identifier");
      if(selected.size>=BUDGET)break;
      if(!selected.has(id)){selected.add(id);added++;}
    }
    coverage[cohort.name]={candidates:rows.length,uniquelySelected:added};
  }
  const ids=[...selected];
  if(ids.length<12||ids.length>BUDGET)
    throw Error("Insufficient bounded synthetic policy witnesses");
  const advancedPolicyStrataCovered=
    ["contract_version","contract_language","nontrivial_drm"]
      .every(name=>coverage[name].candidates>0);
  if (!advancedPolicyStrataCovered)
    throw new Error("Required staged contract, language or DRM legal witnesses are missing");
  const now = new Date().toISOString();
  const reasons = Object.create(null);
  const category = (v) => {
    const code = String(v || "").replace(/[^A-Z0-9_]/g, "");
    return code.length > 0 && code.length < 64 ? code : "UNCLASSIFIED";
  };
  const output = {
    checked: 0,
    canonicalAllowed: 0,
    viewAllowed: 0,
    mismatchedViewPositive: 0,
    mismatchedCanonicalPositive: 0,
    denied: 0,
    reasons,
    policyCohorts:coverage,
    advancedPolicyStrataCovered,
    fullProductionRightsParityCertified:false,
  };
  for (const id of ids) {
    // Neither the canonical results nor product ID is logged or archived.
    const canonical = await resolveProductRights(db, id, "US", {
      salesChannel: "retail",
      at: now,
      persist: false,
    });
    const view = await readOnlySql(RETAIL_VIEW, [id, "US"]);
    const current = Number(view[0]?.permitted || 0) === 1;
    output.checked += 1;
    if (canonical.allowed) output.canonicalAllowed += 1;
    else {
      output.denied += 1;
      const reason = category(canonical.reasonCode);
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
    if (current) output.viewAllowed += 1;
    if (current && !canonical.allowed) output.mismatchedViewPositive += 1;
    if (canonical.allowed && !current) output.mismatchedCanonicalPositive += 1;
  }
  console.log(
    JSON.stringify({
      event: "cove_synthetic_actual_canonical_rights_differential",
      ...output,
      queries: queryCount,
      stageOnly: true,
      releaseCertified: false,
    }),
  );
  assertSyntheticRightsDifferentialCoverage(output);
  console.log(
    "PASS: selected staging legal view matches canonical rights resolver; no production proof",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
