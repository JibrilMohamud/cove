import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { diversitySelect as reference } from "./fixtures/recommendation-selection-v5.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-selector-"));
try {
  await build({
    entryPoints: ["src/features/fore/recommendations.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "actual.mjs"),
    logLevel: "silent",
  });
  const { diversitySelect: actual } = await import(path.join(root, "actual.mjs"));
  function pool(count, features = 12) {
    return Array.from({ length: count }, (_, i) => ({
      productId: "product-" + (i % 93),
      score: 20 - (i % 17) * 0.2,
      sources: new Set(["literary"]),
      reasonCode: "literary",
      reasonText: "Existing reason",
      meta:
        i % 31 === 3
          ? undefined
          : {
              workId: "work-" + (i % 71),
              authorIds: ["a" + (i % 13), "a" + (i % 7)],
              seriesIds: i % 3 ? ["s" + (i % 11)] : [],
              taxonomyPaths: ["root" + (i % 5) + "/child", "root" + (i % 5) + "/other"],
            },
      // Includes duplicates: the original counts candidate features, not a deduplicated set.
      literaryFeatures: Array.from({ length: i % 5 ? features : 0 }, (_, f) => ({
        dimension: "d" + (f % 3),
        feature: "f" + ((i + f) % 7),
        weight: 1,
      })),
    }));
  }
  let cases = 0;
  for (const count of [0, 1, 8, 9, 25, 100, 500])
    for (const limit of [1, 4, 20])
      for (const diversityStrength of [0, 1, 3])
        for (const explorationRate of [0, 0.08, 0.5])
          for (const seed of ["visitor-1", "visitor-2", "visitor-😀"]) {
            const candidates = pool(count),
              before = JSON.stringify(candidates);
            const controls = { diversityStrength, explorationRate };
            const expected = reference(candidates, limit, seed, controls);
            const selected = actual(candidates, limit, seed, controls);
            assert.deepEqual(
              selected.map((c) => candidates.indexOf(c)),
              expected.map((c) => candidates.indexOf(c)),
              `Exact original selection: ${count}/${limit}/${diversityStrength}/${explorationRate}/${seed}`,
            );
            assert.equal(
              JSON.stringify(candidates),
              before,
              "Selection must not mutate shared input",
            );
            cases++;
          }
  const timings = [];
  const cpu = (fn, candidates, seed) => {
    const start = process.cpuUsage();
    fn(candidates, 20, seed, { diversityStrength: 1, explorationRate: 0.08 });
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  for (const features of [0, 12]) {
    const candidates = pool(500, features),
      baseline = [],
      optimized = [];
    for (let i = 0; i < 5; i++) {
      reference(candidates, 20, "warm" + i);
      actual(candidates, 20, "warm" + i);
    }
    for (let i = 0; i < 20; i++) {
      if (i % 2) {
        baseline.push(cpu(reference, candidates, "bench" + i));
        optimized.push(cpu(actual, candidates, "bench" + i));
      } else {
        optimized.push(cpu(actual, candidates, "bench" + i));
        baseline.push(cpu(reference, candidates, "bench" + i));
      }
    }
    timings.push({
      candidates: 500,
      limit: 20,
      features,
      referenceCpuMedianMs: median(baseline),
      optimizedCpuMedianMs: median(optimized),
    });
  }
  const evidence = {
    sha: process.env.GITHUB_SHA,
    cases,
    referenceRuntime: "b2a5236",
    timings,
    cloudflareCapacityCertified: false,
  };
  fs.mkdirSync("artifacts/recommendation-selection", { recursive: true });
  fs.writeFileSync(
    "artifacts/recommendation-selection/results.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
  console.log(
    "PASS: exact original selector including exploration, duplicate works/features/roots, missing metadata, ties and input immutability",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
