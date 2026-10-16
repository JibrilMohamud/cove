import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Diagnostic only: never activates a model or treats synthetic examples as
// human truth. Shared-book and shared-composition labels are correlated.
export function auditRankerEvidence(evaluations, core, weights) {
  const rows = evaluations.map((r) => core.evaluationExampleSchema.parse(r));
  const details = core.evaluateRanker(rows, weights);
  const release = core.rankerReleaseEvidence(rows, weights);
  const assessors = new Set(rows.map((r) => r.actor).filter(Boolean));
  const distinctBooks = new Set(details.subsets.bookHoldout.map((r) => r.book_family));
  const distinctWorks = new Set(
    details.subsets.musicHoldout.flatMap((r) => [r.a.workFamily, r.b.workFamily]),
  );
  const answer = (row, ranker) => {
    const diff =
      core.featureScore(row.a.features, ranker) - core.featureScore(row.b.features, ranker);
    return Math.abs(diff) < 1e-9 ? 0.5 : Number(diff > 0 === (row.preferred === "a"));
  };
  const groups = (items, key) => {
    const out = new Map();
    for (const item of items) {
      const label = key(item);
      if (!out.has(label)) out.set(label, []);
      out.get(label).push(item);
    }
    return [...out.values()];
  };
  const hash = createHash("sha256")
    .update(core.canonicalJson(rows.map((r) => r.id)))
    .digest();
  let state = hash.readUInt32LE(0) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const interval = (items, key) => {
    const clusters = groups(items, key);
    if (clusters.length < 5) return null;
    const aggregates = clusters.map((cluster) => ({
      count: cluster.length,
      delta: cluster.reduce(
        (n, row) => n + answer(row, weights) - answer(row, core.baselineWeights),
        0,
      ),
    }));
    const samples = [];
    for (let i = 0; i < 1200; i++) {
      let count = 0;
      let gain = 0;
      for (let j = 0; j < aggregates.length; j++) {
        const item = aggregates[Math.floor(random() * aggregates.length)];
        gain += item.delta;
        count += item.count;
      }
      samples.push(gain / Math.max(1, count));
    }
    samples.sort((a, b) => a - b);
    return {
      method: "deterministic_cluster_bootstrap_exploratory",
      clusters: clusters.length,
      lower95: Number(samples[Math.floor(samples.length * 0.025)].toFixed(4)),
      upper95: Number(samples[Math.floor(samples.length * 0.975)].toFixed(4)),
    };
  };
  const holdouts = {
    book: {
      ...details.bookHoldout,
      familyCount: distinctBooks.size,
      gain: details.bookHoldout.accuracy - details.bookHoldout.baselineAccuracy,
      gainInterval: interval(details.subsets.bookHoldout, (r) => r.book_family),
    },
    composition: {
      ...details.musicHoldout,
      familyCount: distinctWorks.size,
      gain: details.musicHoldout.accuracy - details.musicHoldout.baselineAccuracy,
      // Key by both composition families; this is still exploratory because
      // overlapping works across keys can create non-independent judgments.
      gainInterval: interval(details.subsets.musicHoldout, (r) =>
        [r.a.workFamily, r.b.workFamily].sort().join("|"),
      ),
    },
  };
  const conditions = {
    trainedOnHumanJudgments:
      release.conditions.staffAuthoredOnly &&
      release.conditions.threeStaffAssessors &&
      release.conditions.reviewerIndependence,
    sufficientTrainPairs: details.trainPairs >= 100,
    unseenBooks: release.conditions.bookHoldoutCoverage,
    unseenCompositions: release.conditions.compositionHoldoutCoverage,
    positiveBookGeneralization:
      !!holdouts.book.gainInterval && holdouts.book.gainInterval.lower95 > 0,
    noMaterialCompositionRegression:
      !!holdouts.composition.gainInterval && holdouts.composition.gainInterval.lower95 >= -0.02,
  };
  return {
    policy: core.MATCHING_POLICY,
    purpose: "human_evidence_diagnostic_not_accuracy_certification",
    evaluationCount: rows.length,
    independentPrincipals: assessors.size,
    trainingPairs: details.trainPairs,
    holdouts,
    checks: conditions,
    releaseEvidence: release.evidence,
    conservativeReviewReady: Object.values(conditions).every(Boolean),
    limitations: [
      "Only actual independent, blinded reader/listener trials establish perceived fit.",
      "Reviewer accounts do not prove independent human identity.",
      "Composition-family annotations must be checked across alternate recordings.",
      "Bootstrap confidence intervals remain exploratory when compositions recur across pairs.",
      "Synthetic fixture results are never real-world model accuracy.",
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .reduce(
        (pairs, arg, i, all) =>
          arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs,
        [],
      ),
  );
  if (!args.input || !args.output)
    throw Error(
      "Usage: node scripts/matching/audit-human-ranker.mjs --input judgments.json --output audit.json [--ranker ranker.json]",
    );
  if (fs.statSync(args.input).size > 20 * 1024 * 1024) throw Error("Evaluation export too large");
  const data = JSON.parse(fs.readFileSync(args.input, "utf8"));
  if (data.source !== "independent_human_judgments" || !Array.isArray(data.evaluations))
    throw Error("An authoritative editorial export is required");
  const ids = data.evaluations.map((e) => e.id);
  if (data.evaluations.length > 10000 || new Set(ids).size !== ids.length)
    throw Error("Invalid editorial judgment identities");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cove-matching-audit-"));
  try {
    await build({
      entryPoints: [
        fileURLToPath(new URL("../../src/features/fore/matching-engine.ts", import.meta.url)),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: path.join(temp, "core.mjs"),
      logLevel: "silent",
    });
    const core = await import(path.join(temp, "core.mjs"));
    const ranker = args.ranker
      ? core.rankerSchema.parse(JSON.parse(fs.readFileSync(args.ranker, "utf8")))
      : null;
    const result = auditRankerEvidence(
      data.evaluations,
      core,
      ranker?.weights ?? core.baselineWeights,
    );
    result.modelId = ranker?.id ?? "transparent_baseline_v1";
    fs.writeFileSync(args.output, JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(
      JSON.stringify({
        modelId: result.modelId,
        conservativeReviewReady: result.conservativeReviewReady,
        checks: result.checks,
      }) + "\n",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
