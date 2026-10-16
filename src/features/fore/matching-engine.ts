import { z } from "zod";
import type { LiteraryProfile } from "./literary-profile";
import { musicReportSchema } from "./music-profile";

export const MATCHING_POLICY = "cove-matching-v1";
export const modes = ["focus", "atmosphere", "immersion"] as const;
export type ListeningMode = (typeof modes)[number];
const unit = z.number().finite().min(0).max(1);
export const featureSchema = z
  .object({
    mood: unit,
    nuance: unit,
    energy: unit,
    tension: unit,
    valence: unit,
    instrument: unit,
    texture: unit,
    attention: unit,
    dynamics: unit,
    semanticCoverage: unit,
    vocalDeclaration: unit,
    era: unit,
    duration: unit,
    preference: unit,
    evidence: unit,
    focusStability: unit,
  })
  .strict();
export type MatchFeatures = z.infer<typeof featureSchema>;
export const featureNames = Object.keys(featureSchema.shape) as (keyof MatchFeatures)[];
const weight = z.number().finite().min(0).max(20);
const weightsSchema = featureSchema
  .extend({
    mood: weight,
    nuance: weight,
    energy: weight,
    tension: weight,
    valence: weight,
    instrument: weight,
    texture: weight,
    attention: weight,
    dynamics: weight,
    semanticCoverage: weight,
    vocalDeclaration: weight,
    era: weight,
    duration: weight,
    preference: weight,
    evidence: weight,
    focusStability: weight,
  })
  .refine((v) => Object.values(v).reduce((a, b) => a + b, 0) > 0, "Empty ranker");
export const rankerSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,100}$/),
    policy: z.literal(MATCHING_POLICY),
    method: z.literal("human_pairwise_linear"),
    weights: weightsSchema,
    datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
    evaluation: z
      .object({
        source: z.literal("independent_human_judgments"),
        trainPairs: z.number().int().min(100),
        throughId: z.number().int().positive(),
        exportCount: z.number().int().min(100).max(10000),
        bookHoldout: z
          .object({ pairs: z.number().int().min(20), accuracy: unit, baselineAccuracy: unit })
          .strict(),
        musicHoldout: z
          .object({ pairs: z.number().int().min(20), accuracy: unit, baselineAccuracy: unit })
          .strict(),
        split: z.literal("family_holdouts_v1"),
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      v.evaluation.bookHoldout.accuracy >= v.evaluation.bookHoldout.baselineAccuracy + 0.02 &&
      v.evaluation.musicHoldout.accuracy >= v.evaluation.musicHoldout.baselineAccuracy,
    "Ranker must improve both family holdouts",
  );
export type LearnedRanker = z.infer<typeof rankerSchema>;
export const baselineWeights: MatchFeatures = {
  mood: 0.18,
  nuance: 0.1,
  energy: 0.13,
  tension: 0.06,
  valence: 0.06,
  instrument: 0.06,
  texture: 0.04,
  attention: 0.11,
  dynamics: 0.05,
  semanticCoverage: 0.02,
  vocalDeclaration: 0.02,
  era: 0.02,
  duration: 0.04,
  preference: 0.04,
  evidence: 0.05,
  focusStability: 0.02,
};
export function featureScore(features: MatchFeatures, weights = baselineWeights) {
  return (
    featureNames.reduce((n, k) => n + features[k] * weights[k], 0) /
    Object.values(weights).reduce((a, b) => a + b, 0)
  );
}
const binSchema = musicReportSchema.shape.structure.shape.timeline.element;
export const matchingAudioSchema = z
  .object({
    durationSeconds: musicReportSchema.shape.durationSeconds,
    signal: musicReportSchema.shape.signal,
    loudness: musicReportSchema.shape.loudness,
    semantics: musicReportSchema.shape.semantics,
    entry: binSchema,
    exit: binSchema,
    trajectory: z.array(binSchema).min(1).max(8),
    semanticFraction: unit,
    sourceSha1: musicReportSchema.shape.sourceSha1,
    sha256: musicReportSchema.shape.sha256,
  })
  .strict();
export type MatchingAudio = z.infer<typeof matchingAudioSchema>;
export type MatchingRecording = {
  id: string;
  fingerprint: string;
  title: string;
  composer: string;
  performer: string;
  period: string;
  instruments: string[];
  moods: string[];
  hasVocals: boolean | null;
  compositionYears: [number | null, number | null];
  reconstruction: boolean | null;
  audio: MatchingAudio;
  attribution: string;
  license: string;
  licenseUrl: string;
  sourcePage: string;
  audioUrl: string;
  profileUrl: string;
};
export type MatchOptions = {
  mode: ListeningMode;
  vocals: "none" | "limited" | "any";
  progress: number;
  sessionSeconds?: number;
  maxTracks: number;
  preferredInstruments?: string[];
  intensityCeiling?: number;
};
export const matchQuerySchema = z.object({
  mode: z.enum(modes).default("atmosphere"),
  vocals: z.enum(["none", "limited", "any"]).optional(),
  progress: z.coerce.number().finite().min(0).max(0.99).default(0),
  sessionSeconds: z.coerce.number().finite().int().min(30).max(7200).optional(),
  maxTracks: z.coerce.number().finite().int().min(1).max(32).default(24),
});
export type ReadingDuration = {
  estimatedSeconds: number;
  rangeSeconds: [number, number | null];
  confidence: number;
  lowerBoundOnly: boolean;
  method: string;
};
export function readingDuration(input: unknown): ReadingDuration | null {
  const r = z
    .object({
      estimatedSeconds: z.number().positive().optional(),
      estimatedMinutes: z.number().positive(),
      rangeSeconds: z
        .tuple([z.number().nonnegative(), z.number().nonnegative().nullable()])
        .optional(),
      rangeMinutes: z.tuple([z.number().nonnegative(), z.number().nonnegative().nullable()]),
      confidence: unit,
      lowerBoundOnly: z.boolean(),
      method: z.string(),
    })
    .passthrough()
    .safeParse(input);
  if (!r.success) return null;
  const v = r.data;
  return {
    estimatedSeconds: v.estimatedSeconds ?? v.estimatedMinutes * 60,
    rangeSeconds: v.rangeSeconds ?? [
      v.rangeMinutes[0] * 60,
      v.rangeMinutes[1] === null ? null : v.rangeMinutes[1] * 60,
    ],
    confidence: v.confidence,
    lowerBoundOnly: v.lowerBoundOnly,
    method: v.method,
  };
}
export function sumReadingDurations(values: ReadingDuration[]): ReadingDuration | null {
  if (!values.length) return null;
  return {
    estimatedSeconds: values.reduce((n, v) => n + v.estimatedSeconds, 0),
    rangeSeconds: [
      values.reduce((n, v) => n + v.rangeSeconds[0], 0),
      values.some((v) => v.rangeSeconds[1] === null)
        ? null
        : values.reduce((n, v) => n + v.rangeSeconds[1]!, 0),
    ],
    confidence: Math.min(...values.map((v) => v.confidence)),
    lowerBoundOnly: values.some((v) => v.lowerBoundOnly),
    method: "section_sum",
  };
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const normalized = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
// A versioned, inspectable semantic basis. These are heuristic associations,
// not newly inferred literary facts or calibrated audio probabilities.
const semanticBasis: Record<string, number[]> = {
  serene: [0, 1, 0.2, 0, 0, 0, 0, 0.4],
  gentle: [0, 0.9, 0.4, 0, 0, 0, 0, 0.5],
  reflective: [0.3, 0.7, 0.2, 0.1, 0, 0, 0, 0.5],
  wistful: [0.8, 0.5, 0.3, 0.1, 0, 0, 0, 0.5],
  melancholic: [1, 0.3, 0.1, 0.2, 0, 0, 0, 0.3],
  melancholy: [1, 0.3, 0.1, 0.2, 0, 0, 0, 0.3],
  warm: [0, 0.5, 1, 0, 0, 0.2, 0, 0.5],
  tender: [0.1, 0.5, 1, 0, 0, 0, 0, 1],
  romantic: [0.3, 0.3, 0.8, 0.2, 0.1, 0, 0, 0.8],
  tense: [0.1, 0, 0, 1, 0.2, 0, 0.2, 0],
  dramatic: [0.2, 0, 0, 0.9, 0.5, 0, 0.1, 0],
  menacing: [0.2, 0, 0, 1, 0.1, 0, 0.6, 0],
  brooding: [0.6, 0.1, 0, 0.7, 0, 0, 0.4, 0.2],
  unsettling: [0.2, 0, 0, 0.6, 0, 0, 1, 0.2],
  uncanny: [0.1, 0.1, 0, 0.4, 0, 0, 1, 0.3],
  heroic: [0, 0, 0.2, 0.5, 1, 0.1, 0, 0],
  majestic: [0, 0.2, 0.2, 0.2, 1, 0, 0, 0],
  solemn: [0.4, 0.4, 0.1, 0.3, 0.7, 0, 0.1, 0],
  playful: [0, 0.1, 0.4, 0.1, 0, 1, 0, 0.2],
  animated: [0, 0, 0.3, 0.2, 0.2, 1, 0, 0],
  joyful: [0, 0.1, 0.8, 0, 0.1, 0.9, 0, 0.1],
  delicate: [0.2, 0.6, 0.2, 0.1, 0, 0, 0.1, 1],
  fragile: [0.4, 0.5, 0.2, 0.2, 0, 0, 0.2, 1],
  introspective: [0.4, 0.7, 0.1, 0.2, 0, 0, 0, 0.8],
  restrained: [0.1, 0.8, 0.1, 0.2, 0, 0, 0, 0.6],
  dark: [0.4, 0, 0, 0.7, 0, 0, 0.7, 0],
  claustrophobic: [0.3, 0, 0, 0.9, 0, 0, 0.8, 0],
  luminous: [0, 0.7, 0.7, 0, 0.3, 0.2, 0, 0.1],
  spacious: [0, 0.8, 0.2, 0, 0.4, 0, 0.1, 0.1],
  ceremonial: [0.1, 0.4, 0.1, 0.2, 1, 0, 0, 0],
};
function vector(tags: string[]) {
  const v = Array<number>(8).fill(0);
  let found = 0;
  for (const tag of tags)
    for (const token of normalized(tag).split(" ")) {
      const b = semanticBasis[token];
      if (!b) continue;
      found++;
      b.forEach((n, i) => (v[i] += n));
    }
  return found ? v.map((n) => n / found) : null;
}
function semanticFit(a: string[], b: string[]) {
  const x = vector(a),
    y = vector(b);
  if (!x || !y) return 0;
  const d = Math.sqrt(x.reduce((n, v) => n + v * v, 0) * y.reduce((n, v) => n + v * v, 0));
  return d ? clamp(x.reduce((n, v, i) => n + v * y[i], 0) / d) : 0;
}
export function retrievalMoodLabels(tags: string[]) {
  const labels = [
    "serene",
    "wistful",
    "warm",
    "playful",
    "tense",
    "menacing",
    "majestic",
    "melancholic",
    "solemn",
    "romantic",
    "brooding",
    "heroic",
  ];
  return [
    ...new Set([
      ...tags.map(normalized),
      ...labels.filter((label) => semanticFit(tags, [label]) > 0.65),
    ]),
  ].slice(0, 16);
}
const instrumentFamilies: Record<string, string[]> = {
  strings: ["violin", "viola", "cello", "double bass"],
  woodwinds: ["flute", "oboe", "clarinet", "bassoon"],
  keyboards: ["piano", "organ"],
  brass: ["trumpet", "trombone", "horn", "tuba"],
};
function instrumentFit(wanted: string[], actual: string[]) {
  if (!wanted.length || !actual.length) return 0;
  const values = new Set(actual.map(normalized));
  return (
    wanted.reduce((n, w) => {
      const key = normalized(w);
      if (values.has(key) || instrumentFamilies[key]?.some((v) => values.has(v))) return n + 1;
      // A broad family declaration supplies partial evidence for a specific member;
      // a cello does not become a violin simply because both are strings.
      return (
        n +
        (Object.entries(instrumentFamilies).some(
          ([family, members]) => members.includes(key) && values.has(family),
        )
          ? 0.4
          : 0)
      );
    }, 0) / wanted.length
  );
}
function texture(s: string) {
  const value = normalized(s);
  if (/arpeggi/.test(value)) return "arpeggios";
  if (/sparse|open texture/.test(value)) return "sparse";
  if (/dense|layered/.test(value)) return "dense";
  if (/staccato|short notes/.test(value)) return "staccato";
  if (/dron/.test(value)) return "drone";
  if (/legato|sustained/.test(value)) return "sustained";
  return value;
}
function overlap(a: string[], b: string[], map: (s: string) => string = normalized) {
  if (!a.length || !b.length) return 0;
  const set = new Set(b.map(map));
  return new Set(a.map(map).filter((t) => set.has(t))).size / new Set(a.map(map)).size;
}
export function listeningTarget(
  profile: LiteraryProfile,
  mode: ListeningMode,
  intensityCeiling = 1,
) {
  const reliable = (key: "moods" | "sensoryAtmosphere" | "literaryStyle") =>
    profile[key].confidence > 0 ? profile[key].value : [];
  const dense =
    profile.literaryStyle.confidence > 0 &&
    /dense|complex|ornate|philosophical|experimental/.test(reliable("literaryStyle").join(" "));
  const narrative = profile.energy.confidence > 0 ? profile.energy.value : null;
  const maxEnergy = Math.min(
    profile.listening.maxEnergy,
    intensityCeiling,
    mode === "focus" ? 0.5 : mode === "atmosphere" ? 0.65 : 0.8,
    dense ? 0.45 : 1,
  );
  const energy = Math.min(
    maxEnergy,
    (narrative ?? 0.25) * (mode === "focus" ? 0.65 : mode === "atmosphere" ? 0.85 : 1),
  );
  const evidence = Math.max(
    profile.moods.value.length ? profile.moods.confidence : 0,
    profile.energy.value !== null ? profile.energy.confidence : 0,
    profile.sensoryAtmosphere.value.length ? profile.sensoryAtmosphere.confidence : 0,
    profile.musicalAffinity.value.instruments.length ||
      profile.musicalAffinity.value.textures.length
      ? profile.musicalAffinity.confidence
      : 0,
  );
  return {
    mode,
    energy,
    maxEnergy,
    dense,
    moods: reliable("moods"),
    nuance: reliable("sensoryAtmosphere"),
    evidence,
    description: {
      emotionalCharacter: reliable("moods"),
      atmosphere: reliable("sensoryAtmosphere"),
      energy,
      energyPolicy: "reading_support_with_intensity_ceiling",
    },
  };
}
export type PersonalFeedback =
  "good_fit" | "poor_fit" | "too_intense" | "distracting_vocals" | "too_repetitive";
export function scoreRecording(
  profile: LiteraryProfile,
  r: MatchingRecording,
  options: MatchOptions,
  duration: ReadingDuration,
  feedback?: PersonalFeedback,
  ranker?: LearnedRanker,
) {
  const t = listeningTarget(profile, options.mode, options.intensityCeiling),
    a = r.audio,
    s = a.semantics;
  if (t.evidence < 0.15) return { excluded: "insufficient_literary_evidence" } as const;
  if (!profile.musicalAffinity.value.allowReconstructions && r.reconstruction === true)
    return { excluded: "reconstruction_preference" } as const;
  if (a.signal.energy > t.maxEnergy) return { excluded: "energy_ceiling" } as const;
  if (feedback === "poor_fit" || feedback === "distracting_vocals")
    return { excluded: "explicit_reader_feedback" } as const;
  if (
    options.vocals === "none" &&
    (r.hasVocals !== false || (s?.dimensions.vocalPresence ?? 0) > 0.65)
  )
    return { excluded: "instrumental_requirement" } as const;
  if (
    options.vocals === "limited" &&
    (r.hasVocals === true || (s?.dimensions.vocalPresence ?? 0) > 0.65)
  )
    return { excluded: "vocal_limit" } as const;
  const semanticConfidence = s?.confidence ?? 0;
  const moods = s?.moods.filter((m) => m.similarity >= 0.18).map((m) => m.label) ?? [];
  const vocalRisk = Math.max(
    r.hasVocals === true ? 1 : r.hasVocals === null ? 0.6 : 0,
    s?.dimensions.vocalPresence ?? 0.35,
  );
  const dynamics = 1 - clamp(a.loudness.loudnessRangeLu / 24);
  const stability =
    1 - clamp(0.55 * a.signal.abruptTransitionRate + 0.45 * a.signal.rhythmicActivity);
  const desiredValence = profile.valence.value === null ? 0.5 : (profile.valence.value + 1) / 2;
  const desiredTension = profile.tension.value ?? 0.2;
  const inferredTension = semanticFit(["tense"], moods);
  const affinity = profile.musicalAffinity;
  const period =
    affinity.value.eraMode === "written" ? profile.writtenPeriod : profile.settingPeriod;
  const historical =
    ["written", "setting"].includes(affinity.value.eraMode) &&
    period.confidence > 0 &&
    period.value.startYear !== null &&
    period.value.endYear !== null &&
    r.compositionYears[0] !== null &&
    r.compositionYears[1] !== null;
  const compositionOverlap = historical
    ? Number(
        r.compositionYears[0]! <= period.value.endYear! &&
          r.compositionYears[1]! >= period.value.startYear!,
      ) * period.confidence
    : 0;
  const era = Math.max(
    compositionOverlap,
    affinity.value.preferredPeriods.map(normalized).includes(normalized(r.period))
      ? affinity.confidence
      : 0,
  );
  const coverage = Math.sqrt(a.semanticFraction);
  const features: MatchFeatures = {
    mood: semanticFit(t.moods, moods) * profile.moods.confidence * semanticConfidence,
    nuance:
      semanticFit(t.nuance, s?.nuance ?? []) *
      profile.sensoryAtmosphere.confidence *
      semanticConfidence,
    energy: (1 - Math.abs(t.energy - a.signal.energy)) * profile.energy.confidence,
    tension:
      (1 - Math.abs(desiredTension - inferredTension)) *
      profile.tension.confidence *
      semanticConfidence *
      (moods.length ? 1 : 0),
    valence:
      s?.dimensions.valence === null || s?.dimensions.valence === undefined
        ? 0
        : (1 - Math.abs(desiredValence - s.dimensions.valence)) *
          profile.valence.confidence *
          semanticConfidence,
    instrument:
      instrumentFit(
        options.preferredInstruments?.length
          ? options.preferredInstruments
          : affinity.value.instruments,
        s?.dimensions.instruments ?? [],
      ) *
      (options.preferredInstruments?.length ? 1 : affinity.confidence) *
      semanticConfidence,
    texture:
      overlap(affinity.value.textures, s?.dimensions.texture ?? [], texture) *
      affinity.confidence *
      semanticConfidence,
    attention: clamp(
      1 - 0.45 * vocalRisk - 0.3 * a.signal.rhythmicActivity - 0.25 * a.signal.abruptTransitionRate,
    ),
    dynamics,
    semanticCoverage: coverage,
    vocalDeclaration: r.hasVocals === false ? 1 : 0.4,
    era,
    duration: clamp(
      Math.min(a.durationSeconds, duration.estimatedSeconds) /
        Math.max(a.durationSeconds, duration.estimatedSeconds),
    ),
    preference: feedback === "good_fit" ? 1 : feedback === undefined ? 0.5 : 0.1,
    evidence: clamp((t.evidence + semanticConfidence + coverage) / 3),
    focusStability:
      stability * (options.mode === "focus" ? 1 : options.mode === "atmosphere" ? 0.7 : 0.4),
  };
  if (
    Math.max(
      features.mood,
      features.nuance,
      features.energy,
      features.tension,
      features.valence,
      features.instrument,
      features.texture,
      features.era,
    ) < 0.05
  )
    return { excluded: "insufficient_pair_evidence" } as const;
  if (feedback === "too_intense") features.energy *= 0.5;
  if (feedback === "too_repetitive") features.preference = 0;
  const score = featureScore(features, ranker?.weights);
  const reasons = (
    [
      ["mood", "supported emotional compatibility"],
      ["nuance", "supported atmospheric nuance"],
      ["energy", "measured intensity fits reading target"],
      ["instrument", "estimated instrumentation fits preference"],
      ["attention", "low estimated attention demands"],
      ["dynamics", "limited measured volume variation"],
      [
        "era",
        compositionOverlap > 0
          ? "evidenced composition-period overlap"
          : "declared musical style fits preference",
      ],
    ] as const
  )
    .filter(([k]) => features[k] > 0.4)
    .map(([, reason]) => reason);
  return {
    id: r.id,
    score: Number(score.toFixed(6)),
    baselineScore: featureScore(features),
    features,
    reasons,
    confidence: Math.min(0.6, features.evidence),
    confidenceMeaning: "uncalibrated_evidence_coverage",
    recording: r,
  } as const;
}
export type ScoredRecording = Extract<ReturnType<typeof scoreRecording>, { id: string }>;
export type ArcSection = { profile: LiteraryProfile; seconds: number; sectionId: string };
function transition(a: MatchingRecording, b: MatchingRecording) {
  const x = a.audio,
    y = b.audio;
  return clamp(
    (0.4 * Math.abs(x.exit.rmsDbfs - y.entry.rmsDbfs)) / 18 +
      0.25 * Math.abs(x.signal.energy - y.signal.energy) +
      (0.2 * Math.abs(x.exit.centroidHz - y.entry.centroidHz)) / 5000 +
      0.15 * Math.abs(x.signal.rhythmicActivity - y.signal.rhythmicActivity),
  );
}
/**
 * Preserve strong local candidates at different points in a reading session.
 * A global top-N shortlist alone can erase a climactic theme in a mostly calm book.
 * Eligibility and user-feedback gates have already been applied to `ranked`;
 * the local scoring callback can further abstain, never restore excluded audio.
 */
export function selectNarrativeCandidates<T extends { id: string }>(
  ranked: T[],
  checkpoints: LiteraryProfile[],
  scoreAt: (profile: LiteraryProfile, candidate: T) => number | null,
  limit = 80,
): T[] {
  if (ranked.length <= limit || !checkpoints.length) return ranked.slice(0, limit);
  const globalCount = Math.min(40, limit);
  const selected = ranked.slice(0, globalCount);
  const seen = new Set(selected.map((r) => r.id));
  const perCheckpoint = Math.max(1, Math.floor((limit - globalCount) / checkpoints.length));
  for (const profile of checkpoints) {
    const local = ranked
      .filter((candidate) => !seen.has(candidate.id))
      .map((candidate) => ({ candidate, score: scoreAt(profile, candidate) }))
      .filter(
        (item): item is { candidate: T; score: number } =>
          item.score !== null && Number.isFinite(item.score),
      )
      .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
      .slice(0, perCheckpoint);
    for (const item of local) {
      if (selected.length >= limit) break;
      selected.push(item.candidate);
      seen.add(item.candidate.id);
    }
  }
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    if (!seen.has(candidate.id)) {
      selected.push(candidate);
      seen.add(candidate.id);
    }
  }
  return selected;
}

export function sequencePlaylist(
  ranked: ScoredRecording[],
  profile: LiteraryProfile,
  options: MatchOptions,
  duration: ReadingDuration,
  arc: ArcSection[],
  ranker?: LearnedRanker,
) {
  const remaining = duration.estimatedSeconds * (1 - options.progress);
  const target = Math.min(7200, remaining, options.sessionSeconds ?? remaining);
  if (!ranked.length)
    return {
      tracks: [],
      durationSeconds: 0,
      targetSeconds: target,
      completion: "no_eligible_matches",
      coversEstimatedSession: false,
    };
  const totalArc = arc.reduce((n, s) => n + s.seconds, 0);
  const at = (seconds: number) => {
    let position = (options.progress + seconds / duration.estimatedSeconds) * totalArc;
    for (const section of arc) {
      position -= section.seconds;
      if (position < 0) return section.profile;
    }
    return arc.at(-1)?.profile ?? profile;
  };
  const localCache = new Map<LiteraryProfile, Map<string, ScoredRecording | null>>();
  const localMatch = (p: LiteraryProfile, candidate: ScoredRecording) => {
    let cache = localCache.get(p);
    if (!cache) {
      cache = new Map();
      localCache.set(p, cache);
    }
    if (cache.has(candidate.id)) return cache.get(candidate.id)!;
    const result = scoreRecording(p, candidate.recording, options, duration, undefined, ranker);
    if (result.excluded !== undefined) {
      cache.set(candidate.id, null);
      return null;
    }
    result.features.preference = candidate.features.preference;
    const matched = { ...result, score: featureScore(result.features, ranker?.weights) };
    cache.set(candidate.id, matched);
    return matched;
  };
  // Sample the *remaining* narrative, not merely the book's average mood.
  // A 40-record global core preserves consistent choices; local checkpoints
  // introduce 40 more candidates that may only suit later scenes.
  const checkpoints =
    totalArc > 0 ? [0, 0.2, 0.4, 0.6, 0.8, 0.98].map((fraction) => at(target * fraction)) : [];
  const pool = selectNarrativeCandidates(
    ranked,
    checkpoints,
    (passage, candidate) => localMatch(passage, candidate)?.score ?? null,
  );
  type State = { items: ScoredRecording[]; seconds: number; utility: number; costs: number[] };
  const normalizedUtility = (state: State) =>
    state.utility / Math.max(1, state.seconds) -
    (0.2 * Math.abs(state.seconds - target)) / Math.max(30, target);
  let beam: State[] = [{ items: [], seconds: 0, utility: 0, costs: [] }],
    finished: State[] = [];
  for (let step = 0; step < options.maxTracks; step++) {
    const next: State[] = [];
    for (const state of beam) {
      const used = new Set(state.items.map((x) => x.recording.audio.sourceSha1));
      const p = at(state.seconds);
      const choices = pool
        .filter((x) => !used.has(x.recording.audio.sourceSha1))
        .flatMap((candidate) => {
          const local = localMatch(p, candidate);
          if (!local) return [];
          const previous = state.items.at(-1)?.recording;
          const cost = previous ? transition(previous, candidate.recording) : 0;
          const composerRepeats = state.items
            .slice(-2)
            .filter(
              (x) =>
                normalized(x.recording.composer) &&
                normalized(x.recording.composer) === normalized(candidate.recording.composer),
            ).length;
          const workRepeat = state.items.some(
            (x) =>
              normalized(x.recording.title) === normalized(candidate.recording.title) &&
              normalized(x.recording.composer) === normalized(candidate.recording.composer),
          );
          const audio = candidate.recording.audio;
          const samples = audio.trajectory.filter(
            (bin) => bin.start < Math.max(1, target - state.seconds),
          );
          const cues = samples.length ? samples : [audio.entry];
          const averageRms =
            audio.trajectory.reduce((n, bin) => n + bin.rmsDbfs, 0) / audio.trajectory.length;
          let arcFit = 0,
            localScore = 0;
          for (const bin of cues) {
            const passage = at(
              state.seconds +
                Math.min((bin.start + bin.end) / 2, Math.max(0, target - state.seconds)),
            );
            const desired = listeningTarget(passage, options.mode, options.intensityCeiling).energy;
            const relativeEnergy = clamp(
              audio.signal.energy +
                0.02 * (bin.rmsDbfs - averageRms) +
                0.05 *
                  (bin.onsets / Math.max(0.001, bin.end - bin.start) -
                    audio.signal.onsetsPerSecond),
            );
            arcFit += 1 - Math.abs(desired - relativeEnergy);
            localScore += localMatch(passage, candidate)?.score ?? 0;
          }
          arcFit /= cues.length;
          localScore /= cues.length;
          const value =
            0.35 * candidate.score +
            0.65 * localScore +
            0.12 * arcFit -
            0.18 * cost -
            0.04 * composerRepeats -
            (workRepeat ? 0.2 : 0);
          return [{ candidate, cost, value }];
        })
        .sort((a, b) => b.value - a.value || a.candidate.id.localeCompare(b.candidate.id))
        .slice(0, 16);
      if (!choices.length) {
        finished.push(state);
        continue;
      }
      for (const { candidate, cost, value } of choices) {
        const seconds = candidate.recording.audio.durationSeconds;
        const useful = Math.min(seconds, Math.max(0, target - state.seconds));
        const out = {
          items: [...state.items, candidate],
          seconds: state.seconds + seconds,
          utility: state.utility + value * useful,
          costs: [...state.costs, cost],
        };
        if (out.seconds >= target) finished.push(out);
        else next.push(out);
      }
    }
    // Keep long and short partial sequences competitive; deterministic bounded beam.
    beam = next
      .sort(
        (a, b) =>
          b.utility / Math.max(30, b.seconds) - a.utility / Math.max(30, a.seconds) ||
          a.items
            .map((x) => x.id)
            .join()
            .localeCompare(b.items.map((x) => x.id).join()),
      )
      .slice(0, 8);
    finished = finished.sort((a, b) => normalizedUtility(b) - normalizedUtility(a)).slice(0, 16);
    if (!beam.length) break;
  }
  const all = [...finished, ...beam];
  const complete = all.filter((s) => s.seconds >= target);
  const best = (complete.length ? complete : all).sort(
    (a, b) => normalizedUtility(b) - normalizedUtility(a),
  )[0];
  let start = 0;
  const tracks = best.items.map((match, i) => {
    const out = {
      id: match.id,
      score: localMatch(at(start), match)?.score ?? match.score,
      startSeconds: start,
      endSeconds: start + match.recording.audio.durationSeconds,
      transitionCost: best.costs[i],
      reasons: localMatch(at(start), match)?.reasons ?? match.reasons,
      recording: match.recording,
    };
    start = out.endSeconds;
    return out;
  });
  return {
    tracks,
    durationSeconds: best.seconds,
    targetSeconds: target,
    coversEstimatedSession: best.seconds >= target,
    completion:
      best.seconds >= target
        ? "estimated_session_covered"
        : best.items.length >= options.maxTracks
          ? "track_limit"
          : "eligible_catalog_exhausted",
    fullRemainingBookPlanned:
      !duration.lowerBoundOnly && target >= remaining && best.seconds >= remaining,
    overrunSeconds: Math.max(0, best.seconds - target),
    alignment: "estimated_reading_progress",
    arcEvidence: "chapter_profiles_and_eight_or_fewer_measured_signal_bins",
    playback: "whole_original_recordings_at_natural_boundaries",
  };
}

/** Deterministic family holdouts: no held-out book/work enters training. */
function familyFold(value: string) {
  let n = 2166136261;
  for (const c of value) {
    n ^= c.codePointAt(0)!;
    n = Math.imul(n, 16777619);
  }
  return (n >>> 0) % 5;
}
export function evaluationSplit(bookFamily: string, aFamily: string, bFamily: string) {
  const book = familyFold("book:" + bookFamily) === 0;
  const a = familyFold("music:" + aFamily) === 0,
    b = familyFold("music:" + bFamily) === 0;
  if (!book && !a && !b) return "train";
  if (book && !a && !b) return "bookHoldout";
  if (!book && a && b) return "musicHoldout";
  return "unused";
}
export const evaluationExampleSchema = z
  .object({
    id: z.number().int().positive(),
    policy: z.literal(MATCHING_POLICY),
    book_family: z.string().min(1),
    preferred: z.enum(["a", "b", "tie"]),
    a: z.object({ workFamily: z.string().min(1), features: featureSchema }).passthrough(),
    b: z.object({ workFamily: z.string().min(1), features: featureSchema }).passthrough(),
  })
  .passthrough();
export type EvaluationExample = z.infer<typeof evaluationExampleSchema>;
export function evaluateRanker(rows: EvaluationExample[], weights: MatchFeatures) {
  const subsets = {
    train: [] as EvaluationExample[],
    bookHoldout: [] as EvaluationExample[],
    musicHoldout: [] as EvaluationExample[],
    unused: [] as EvaluationExample[],
  };
  for (const row of rows)
    if (row.preferred !== "tie")
      subsets[evaluationSplit(row.book_family, row.a.workFamily, row.b.workFamily)].push(row);
  const result = (data: EvaluationExample[]) => {
    const accuracy = (w: MatchFeatures) =>
      data.reduce((n, r) => {
        const diff = featureScore(r.a.features, w) - featureScore(r.b.features, w);
        return n + (Math.abs(diff) < 1e-9 ? 0.5 : diff > 0 === (r.preferred === "a") ? 1 : 0);
      }, 0) / Math.max(1, data.length);
    return {
      pairs: data.length,
      accuracy: accuracy(weights),
      baselineAccuracy: accuracy(baselineWeights),
    };
  };
  return {
    trainPairs: subsets.train.length,
    bookHoldout: result(subsets.bookHoldout),
    musicHoldout: result(subsets.musicHoldout),
    subsets,
  };
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
