import { z } from "zod";
export const discoveryRankFeatures = [
  "literary",
  "content",
  "collaborative",
  "affinity",
  "quality",
  "confidence",
] as const;
export const discoveryRankerSchema = z
  .object({
    schema: z.literal("cove-satisfaction-logistic-v1"),
    featureOrder: z.tuple([
      z.literal("literary"),
      z.literal("content"),
      z.literal("collaborative"),
      z.literal("affinity"),
      z.literal("quality"),
      z.literal("confidence"),
    ]),
    weights: z.array(z.number().finite().min(-100).max(100)).length(6),
    intercept: z.number().finite().min(-100).max(100),
    trainedThrough: z.string().datetime(),
    evaluatedThrough: z.string().datetime(),
    trainingExamples: z.number().int().min(100),
    holdoutExamples: z.number().int().min(30),
    brier: z.number().min(0).max(1),
  })
  .strict()
  .refine(
    (v) => Date.parse(v.evaluatedThrough) > Date.parse(v.trainedThrough),
    "Holdout must be later than training",
  );
export type DiscoveryRanker = z.infer<typeof discoveryRankerSchema>;
export function rankFeatures(scores: Map<string, number>, confidence: number): number[] {
  const sum = (keys: string[]) => keys.reduce((v, k) => v + (scores.get(k) || 0), 0);
  return [
    sum(["literary-taste"]) / 12,
    sum(["content", "literary-neighbor", "item-neighbor"]) / 40,
    sum(["collaborative", "collaborative-item"]) / 20,
    sum(["affinity"]) / 6,
    sum(["quality"]) / 5,
    confidence,
  ].map((x) => Math.max(-3, Math.min(3, x)));
}
export function satisfactionPrediction(model: DiscoveryRanker, features: number[]) {
  const logit = model.intercept + model.weights.reduce((s, w, i) => s + w * (features[i] || 0), 0);
  return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, logit))));
}
