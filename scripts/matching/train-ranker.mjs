import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";

// Offline only: no user feedback, network requests, model API or live activation.
export async function trainRanker(examples, core, id) {
  const rows = examples.map((row) => core.evaluationExampleSchema.parse(row));
  const split = core.evaluateRanker(rows, core.baselineWeights);
  if (split.trainPairs < 100 || split.bookHoldout.pairs < 20 || split.musicHoldout.pairs < 20)
    throw Error("Insufficient independent book/work holdouts; collect more human judgments");
  const weights = { ...core.baselineWeights };
  const names = core.featureNames;
  for (let epoch = 0; epoch < 400; epoch++) {
    const learningRate = 0.12 / Math.sqrt(1 + epoch / 30);
    for (let n = 0; n < split.subsets.train.length; n++) {
      const row = split.subsets.train[(n + epoch) % split.subsets.train.length];
      const sign = row.preferred === "a" ? 1 : -1;
      const margin = names.reduce(
        (sum, k) => sum + weights[k] * (row.a.features[k] - row.b.features[k]) * sign,
        0,
      );
      const error = 1 / (1 + Math.exp(Math.min(40, margin)));
      for (const k of names)
        weights[k] = Math.max(
          0,
          Math.min(
            20,
            weights[k] +
              learningRate *
                (error * sign * (row.a.features[k] - row.b.features[k]) - 0.002 * weights[k]),
          ),
        );
    }
  }
  const evaluated = core.evaluateRanker(rows, weights);
  const artifact = {
    id,
    policy: core.MATCHING_POLICY,
    method: "human_pairwise_linear",
    weights,
    datasetSha256: createHash("sha256").update(core.canonicalJson(examples)).digest("hex"),
    evaluation: {
      source: "independent_human_judgments",
      trainPairs: evaluated.trainPairs,
      throughId: Math.max(...rows.map((row) => row.id)),
      exportCount: rows.length,
      bookHoldout: evaluated.bookHoldout,
      musicHoldout: evaluated.musicHoldout,
      split: "family_holdouts_v1",
    },
  };
  // Refuse an artifact that does not improve the declared family holdouts.
  return core.rankerSchema.parse(artifact);
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
  if (!args.input || !args.output || !args.id)
    throw Error(
      "Usage: node scripts/matching/train-ranker.mjs --input judgments.json --output ranker.json --id version_id",
    );
  if (fs.statSync(args.input).size > 20 * 1024 * 1024)
    throw Error("Evaluation export exceeds 20 MB");
  const data = JSON.parse(fs.readFileSync(args.input, "utf8"));
  if (data.source !== "independent_human_judgments" || !Array.isArray(data.evaluations))
    throw Error("Use an authoritative editorial evaluation export");
  const examples = data.evaluations.slice().sort((a, b) => a.id - b.id);
  if (
    !examples.length ||
    examples.length > 10000 ||
    new Set(examples.map((row) => row.id)).size !== examples.length
  )
    throw Error("Invalid evaluation export size/identity");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cove-ranker-training-"));
  try {
    await build({
      entryPoints: [
        fileURLToPath(new URL("../../src/features/fore/matching-engine.ts", import.meta.url)),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: path.join(temp, "engine.mjs"),
      logLevel: "silent",
    });
    const core = await import(path.join(temp, "engine.mjs"));
    const artifact = await trainRanker(examples, core, args.id);
    fs.writeFileSync(args.output, JSON.stringify(artifact, null, 2) + "\n");
    process.stdout.write(
      JSON.stringify({
        id: artifact.id,
        evaluation: artifact.evaluation,
        automaticallyActivated: false,
      }) + "\n",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
