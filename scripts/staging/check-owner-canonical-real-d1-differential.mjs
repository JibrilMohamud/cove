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

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (
  process.env.COVE_SYNTHETIC_OWNER_DIFF_ONLY !== "1" ||
  !TOKEN ||
  process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT ||
  process.env.COVE_SYNTHETIC_D1_ID !== DATABASE
)
  throw new Error("Explicit read-only synthetic D1 legal comparison not authorized");

let queryCount = 0;
async function readOnlySql(sql, params = []) {
  // SQL has no writable verbs or multiple statements; don't run .run/batch.
  if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /;\s*\S/.test(sql))
    throw new Error("Write-capable or multi-statement SQL is forbidden");
  queryCount += 1;
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

  // Systematically include ranked display candidates and nontrivial rights:
  // deny grants, contract-bound grants, or nontrivial DRM requirements.
  const ranked = await readOnlySql(
    "SELECT product_id FROM catalog_search_documents WHERE product_id LIKE 'perf-synth-%' ORDER BY fore_bestseller_score DESC,external_book_id ASC,product_id ASC LIMIT 24",
  );
  const complex = await readOnlySql(
    `SELECT DISTINCT p.id product_id FROM products p
     JOIN rights_grants rg ON rg.edition_id=p.edition_id
     WHERE p.id LIKE 'perf-synth-%'
       AND (rg.contract_id IS NOT NULL OR rg.decision='deny'
       OR lower(rg.drm_requirement) NOT IN ('none','optional','any',''))
     ORDER BY p.id LIMIT 24`,
  );
  const ids = [...new Set([...ranked, ...complex].map((x) => String(x.product_id)))].slice(
    0,
    BUDGET,
  );
  if (ids.length < 12 || ids.some((id) => !/^perf-synth-[A-Za-z0-9_-]{1,120}$/.test(id)))
    throw new Error("Only isolated synthetic product IDs may be evaluated");
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
  if (output.mismatchedViewPositive || output.mismatchedCanonicalPositive)
    throw new Error(
      "DIFFERENTIAL FAIL: actual canonical resolveProductRights disagrees with the stage D1 legal view",
    );
  console.log(
    "PASS: selected staging legal view matches canonical rights resolver; no production proof",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
