import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = mkdtempSync(path.join(tmpdir(), "cove-lit-job-settle-"));
const canonical = new DatabaseSync(":memory:");
const content = new DatabaseSync(":memory:");
const A = "a".repeat(64);
const B = "b".repeat(64);
const token = "f5ddc6ee-17a0-4a6e-af06-fc1f56fd05a6";
const day = "2026-10-23";
const resultKey = (id) => "literary/isolated-inference-v1/" + id + ".json";
function db(sqlite) {
  return {
    prepare(sql) {
      const p = sqlite.prepare(sql);
      const bind = (...v) => ({
        async first() {
          return p.get(...v) ?? null;
        },
        async run() {
          return p.run(...v);
        },
      });
      return { bind, ...bind() };
    },
  };
}
try {
  canonical.exec(
    "CREATE TABLE storefront_authority(value TEXT); INSERT INTO storefront_authority VALUES('untouched')",
  );
  content.exec(
    readFileSync("infra/content-budget/0001_ledger.sql", "utf8") +
      "CREATE TABLE literary_inference_jobs(id TEXT PRIMARY KEY,status TEXT,lease_token TEXT,lease_until TEXT);" +
      readFileSync("infra/content-budget/0009_job_settlements_and_ai_usage.sql", "utf8"),
  );
  content
    .prepare("INSERT INTO literary_budget_cutover VALUES(?,?,?,?,?,?,?)")
    .run(day, "active", 0, 0, day, day, "operator-staging-test");
  content.prepare("INSERT INTO literary_profile_budget VALUES(?,?,?)").run(day, 15000, 2);
  for (const id of [A, B])
    content
      .prepare("INSERT INTO literary_inference_jobs VALUES(?,'running',?,'2099-01-01')")
      .run(id, token);
  await build({
    entryPoints: ["src/lib/literary-job-settlement.server.ts"],
    outfile: path.join(dir, "settlement.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { settleIsolatedLiteraryJob, observedLiteraryAiUsage, recordLiteraryAiInvocation } =
    await import(pathToFileURL(path.join(dir, "settlement.mjs")).href);
  const d1 = db(content);
  const params = (id, extra = {}) => ({
    day,
    jobId: id,
    resultKey: resultKey(id),
    resultSha256: "c".repeat(64),
    leaseToken: token,
    promptCharacters: 6000,
    outputCharacters: 1250,
    reservedOutputCharacters: 12000,
    ...extra,
  });
  const balance = () =>
    content.prepare("SELECT reserved_units FROM literary_profile_budget WHERE day=?").get(day)
      .reserved_units;
  const receiptCount = () =>
    content.prepare("SELECT COUNT(*) n FROM literary_job_output_settlements").get().n;
  assert.deepEqual(await settleIsolatedLiteraryJob(d1, params(A)), {
    refunded: 10750,
    committed: true,
  });
  assert.equal(balance(), 4250);
  assert.equal(receiptCount(), 1);
  assert.ok(
    (
      await Promise.all(Array.from({ length: 15 }, () => settleIsolatedLiteraryJob(d1, params(A))))
    ).every((x) => x.refunded === 0 && !x.committed),
  );
  assert.equal(balance(), 4250, "replays of a committed job cannot credit again");
  assert.equal(receiptCount(), 1, "job receipt remains immutable");
  // Insufficient day balance must abort BOTH the receipt and the credit.
  await assert.rejects(settleIsolatedLiteraryJob(d1, params(B)), /unfunded/);
  assert.equal(receiptCount(), 1);
  assert.equal(balance(), 4250);
  content.prepare("UPDATE literary_profile_budget SET reserved_units=18000 WHERE day=?").run(day);
  assert.deepEqual(await settleIsolatedLiteraryJob(d1, params(B)), {
    refunded: 10750,
    committed: true,
  });
  assert.equal(balance(), 7250);
  assert.equal(receiptCount(), 2);
  // Job ID is not a reusable cache key or arbitrary lease token.
  await assert.rejects(
    settleIsolatedLiteraryJob(d1, params(B, { resultKey: resultKey(A) })),
    /receipt/,
  );
  assert.deepEqual(
    await settleIsolatedLiteraryJob(d1, params(A, { leaseToken: crypto.randomUUID() })),
    { refunded: 0, committed: false },
  );
  content.prepare("UPDATE literary_budget_cutover SET status='closed' WHERE day=?").run(day);
  assert.deepEqual(await settleIsolatedLiteraryJob(d1, params(A)), {
    refunded: 0,
    committed: false,
  });
  const observed = observedLiteraryAiUsage({
    response: "hello",
    usage: { prompt_tokens: 314, completion_tokens: 52, billed_neurons: 19.5, cost_usd: 0.001 },
  });
  assert.deepEqual(observed, {
    inputTokens: 314,
    outputTokens: 52,
    billedNeurons: 19.5,
    providerCostUsd: 0.001,
  });
  assert.deepEqual(observedLiteraryAiUsage({ response: "hello" }), {
    inputTokens: null,
    outputTokens: null,
    billedNeurons: null,
    providerCostUsd: null,
  });
  assert.equal(
    observedLiteraryAiUsage({ usage: { prompt_tokens: "not reported" } }).inputTokens,
    null,
  );
  await recordLiteraryAiInvocation(d1, A, "@cf/test/model", {
    usage: { prompt_tokens: 314, completion_tokens: 52 },
  });
  await recordLiteraryAiInvocation(d1, A, "@cf/test/model", { response: "missing usage" });
  assert.equal(
    content.prepare("SELECT COUNT(*) n FROM literary_ai_invocation_usage WHERE job_id=?").get(A).n,
    2,
    "Retries must be individually measured rather than collapsed by job ID",
  );
  assert.equal(
    content
      .prepare(
        "SELECT COUNT(*) n FROM literary_ai_invocation_usage WHERE provider_cost_usd IS NULL",
      )
      .get().n,
    2,
    "Unreported dollar cost must never be invented from characters",
  );
  assert.equal(
    canonical.prepare("SELECT value FROM storefront_authority").get().value,
    "untouched",
  );
  console.log(
    "LITERARY_JOB_SETTLEMENT_PASS unique immutable job, concurrent replay, atomic credit, unfunded rollback, lease/day fencing, measured tokens, unknown costs, zero primary writes",
  );
} finally {
  canonical.close();
  content.close();
  rmSync(dir, { recursive: true, force: true });
}
