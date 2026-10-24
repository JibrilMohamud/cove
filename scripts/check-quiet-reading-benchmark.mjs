import assert from "node:assert/strict";
import { evaluateQuietReadingLabels, focusEvaluationLimits } from "./quiet-reading-benchmark.mjs";

const make = (i, predictedTier) => {
  const family = ["piano", "orchestral", "ambient", "vocal"][Math.floor(i / 150)];
  const distracting = i % 150 < 75;
  return {
    masterSha256: i.toString(16).padStart(64, "0"),
    family,
    predictedTier: predictedTier || (distracting ? "distracting" : "quiet_focus"),
    ratings: ["judge_1", "judge_2", "judge_3"].map((rater) => ({
      rater,
      label: distracting ? "distracting" : "quiet",
    })),
  };
};
const rows = Array.from({ length: 600 }, (_, i) => make(i));
const success = evaluateQuietReadingLabels(rows);
assert.equal(success.pass, true);
assert.equal(success.sampleCount, focusEvaluationLimits.minimumMasters);
assert.equal(success.distracting, 300);
assert.equal(success.quiet, 300);
assert.equal(success.falseAccept, 0);
assert.equal(success.quietRecall, 1);
assert.equal(success.byGroup.length, 4);
assert.ok(success.falseAcceptanceUpper95 < 0.05);
assert.equal(success.provenance, "external_blind_listening_attestation_required");

const falseAccept = rows.map((row, i) =>
  i % 150 < 15 ? { ...row, predictedTier: "quiet_focus" } : row,
);
const failed = evaluateQuietReadingLabels(falseAccept);
assert.equal(failed.pass, false);
assert.ok(failed.falseAccept > 0);
assert.ok(failed.falseAcceptanceUpper95 > success.falseAcceptanceUpper95);

const noRecall = rows.map((row) => ({ ...row, predictedTier: "distracting" }));
assert.equal(evaluateQuietReadingLabels(noRecall).pass, false);
assert.equal(evaluateQuietReadingLabels(rows.slice(0, 100)).pass, false);
assert.throws(() => evaluateQuietReadingLabels([...rows, rows[0]]), /duplicate/);
assert.throws(
  () => evaluateQuietReadingLabels([{ ...rows[0], ratings: rows[0].ratings.slice(0, 1) }]),
  /Malformed/,
);
assert.throws(
  () =>
    evaluateQuietReadingLabels([
      { ...rows[0], ratings: [...rows[0].ratings.slice(0, 2), rows[0].ratings[0]] },
    ]),
  /Independent/,
);
console.log(
  "Blind-label metric mechanics, family groups, false acceptance and recall gates passed; NO real listening corpus is claimed.",
);
