import fs from "node:fs";
import { pathToFileURL } from "node:url";
const featureOrder = ["literary", "content", "collaborative", "affinity", "quality", "confidence"];
const sigmoid = (x) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, x))));
/** Input snapshots must predate explicit, attributed satisfaction labels. Missing labels stay missing. */
export function trainDiscoveryRanker(input, options = {}) {
  const rows = input
    .filter(
      (r) =>
        Array.isArray(r.features) &&
        r.features.length === 6 &&
        r.features.every(Number.isFinite) &&
        [0, 1].includes(r.label) &&
        Number.isFinite(Date.parse(r.servedAt)) &&
        Date.parse(r.observedAt) > Date.parse(r.servedAt),
    )
    .sort(
      (a, b) =>
        Date.parse(a.servedAt) - Date.parse(b.servedAt) ||
        Date.parse(b.observedAt) - Date.parse(a.observedAt),
    );
  const requests = new Set();
  const unique = rows.filter((r) => {
    const id = `${r.requestId}:${r.productId}`;
    if (requests.has(id)) return false;
    requests.add(id);
    return true;
  });
  const split = Math.floor(unique.length * 0.8);
  const cutoff = unique[split]?.servedAt;
  // Purge delayed training labels that would only be known during holdout.
  const train = unique.filter(
    (r) =>
      Date.parse(r.servedAt) < Date.parse(cutoff) && Date.parse(r.observedAt) < Date.parse(cutoff),
  );
  const test = unique.filter((r) => Date.parse(r.servedAt) >= Date.parse(cutoff));
  if (train.length < (options.minTrain ?? 100) || test.length < (options.minTest ?? 30))
    throw Error("Insufficient temporally separated explicit satisfaction outcomes");
  if (new Set(train.map((r) => r.label)).size < 2 || new Set(test.map((r) => r.label)).size < 2)
    throw Error("Both outcome classes required in train and holdout");
  if (new Set(train.map((r) => r.readerKey)).size < (options.minReaders ?? 20))
    throw Error("Insufficient distinct consenting readers");
  const weights = featureOrder.map(() => 0);
  let intercept = 0;
  for (let epoch = 0; epoch < 600; epoch++) {
    const grad = featureOrder.map(() => 0);
    let bias = 0;
    for (const row of train) {
      const error =
        sigmoid(intercept + weights.reduce((s, w, i) => s + w * row.features[i], 0)) - row.label;
      bias += error;
      row.features.forEach((v, i) => (grad[i] += error * v));
    }
    intercept -= (0.1 * bias) / train.length;
    weights.forEach((w, i) => (weights[i] -= 0.1 * (grad[i] / train.length + 0.01 * w)));
  }
  const prior = train.reduce((s, r) => s + r.label, 0) / train.length;
  const brier =
    test.reduce(
      (s, r) =>
        s +
        (sigmoid(intercept + weights.reduce((v, w, i) => v + w * r.features[i], 0)) - r.label) ** 2,
      0,
    ) / test.length;
  const priorBrier = test.reduce((s, r) => s + (prior - r.label) ** 2, 0) / test.length;
  return {
    model: {
      schema: "cove-satisfaction-logistic-v1",
      featureOrder,
      weights,
      intercept,
      trainedThrough: new Date(
        Math.max(...train.map((r) => Date.parse(r.observedAt))),
      ).toISOString(),
      evaluatedThrough: new Date(
        Math.max(...test.map((r) => Date.parse(r.observedAt))),
      ).toISOString(),
      trainingExamples: train.length,
      holdoutExamples: test.length,
      brier,
    },
    evaluation: {
      priorBrier,
      brier,
      improvesPrior: brier < priorBrier,
      unlabelledExcluded: input.length - rows.length,
      duplicateExclusions: rows.length - unique.length,
      temporalPurge: unique.length - train.length - test.length,
      automaticActivation: false,
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3])
    throw Error("Usage: node scripts/discovery/train-ranker.mjs dataset.json model-report.json");
  const report = trainDiscoveryRanker(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
  fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + "\n");
}
