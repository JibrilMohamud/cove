import { z } from "zod";

export const DISCOVERY_VERSION = "cove-discovery-v1";
export const discoveryDimensions = [
  "themes",
  "moods",
  "literaryStyle",
  "geography",
  "sensoryAtmosphere",
] as const;
export type DiscoveryDimension = (typeof discoveryDimensions)[number];
const tags = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(80)
      .transform((s) => s.toLowerCase()),
  )
  .max(20);
export const tasteControlsSchema = z
  .object({
    likes: tags.default([]),
    dislikes: tags.default([]),
    languages: z
      .array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/))
      .max(8)
      .default([]),
    adventurousness: z.number().min(0).max(1).default(0.3),
    maxMinutes: z.number().int().min(5).max(10000).nullable().default(null),
  })
  .strict();
export type TasteControls = z.infer<typeof tasteControlsSchema>;
export type LiteraryFeature = { dimension: string; feature: string; confidence: number };
export type TasteEvidence = { long: number; recent: number; observations: number };
export type ReaderTaste = Map<string, TasteEvidence>;
export const literaryKey = (f: Pick<LiteraryFeature, "dimension" | "feature">) =>
  `${f.dimension}:${f.feature}`;

/** A bounded evidence score, deliberately not a calibrated enjoyment probability. */
export function literaryCompatibility(
  features: LiteraryFeature[],
  taste: ReaderTaste,
  controls: TasteControls,
) {
  let sum = 0,
    evidence = 0;
  const matches: string[] = [];
  for (const f of features) {
    const t = taste.get(literaryKey(f));
    const explicit = controls.likes.includes(f.feature) ? 2 : 0;
    const negative = controls.dislikes.includes(f.feature) ? -4 : 0;
    const confidence = Math.max(0, Math.min(1, f.confidence));
    const learned = t
      ? (0.65 * Math.tanh(t.long / 6) + 0.35 * Math.tanh(t.recent / 4)) *
        Math.min(1, t.observations / 3)
      : 0;
    sum += confidence * (learned + explicit + negative);
    if (t || explicit || negative) evidence += confidence;
    if ((learned > 0.1 || explicit > 0) && negative === 0) matches.push(f.feature);
  }
  return {
    score: evidence ? 12 * Math.tanh(sum / Math.sqrt(Math.max(1, evidence))) : 0,
    confidence: Math.min(1, evidence / 6),
    matches: [...new Set(matches)].slice(0, 3),
  };
}

/** Repeated clicks cannot outweigh one clear dissatisfaction outcome. Pauses are neutral. */
export function satisfactionEvidence(type: string, value?: number | null) {
  if (type === "rating") return value == null ? 0 : Math.max(-8, Math.min(8, (value - 3) * 4));
  if (type === "loved" || type === "recommend") return 8;
  if (type === "not_for_me") return -8;
  if (type === "abandon") return -2; // Explicit abandonment, never inferred from inactivity.
  if (type === "completion") return 3;
  if (type === "read_progress") return 0.4;
  if (type === "read_start" || type === "wishlist_add") return 0.7;
  if (type === "sample_start") return 0.3;
  if (type === "recommendation_click" || type === "book_view") return 0.05;
  return 0;
}
export type DiscoveryIntent = {
  likes: string[];
  avoids: string[];
  maxMinutes: number | null;
  unresolved: string[];
};
/** Conservative fallback. Never claims to understand arbitrary natural language. */
export function parseDiscoveryIntent(text: string): DiscoveryIntent {
  const clauses = text
    .toLowerCase()
    .split(/[,;.]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const likes: string[] = [],
    avoids: string[] = [],
    unresolved: string[] = [];
  let maxMinutes: number | null = null;
  for (const clause of clauses) {
    const time = /^(?:under|less than) (\d{1,4}) (hours?|minutes?)$/.exec(clause);
    if (time) {
      maxMinutes = Math.max(
        5,
        Math.min(10000, Number(time[1]) * (time[2].startsWith("hour") ? 60 : 1)),
      );
      continue;
    }
    const avoid = /^(?:less |no |avoid |without )(.+)$/.exec(clause);
    const more = /^(?:more |with |about )?([\p{L}\p{N} -]{1,80})$/u.exec(clause);
    if (avoid) avoids.push(avoid[1]);
    else if (more) likes.push(more[1]);
    else unresolved.push(clause);
  }
  return { likes: likes.slice(0, 20), avoids: avoids.slice(0, 20), maxMinutes, unresolved };
}
