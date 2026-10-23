import type { MusicReport } from "./music-profile";

/**
 * Deterministic, versioned *acoustic* triage, not a rights or release decision.
 * Full-signal evidence is required; absent/ambiguous vocal evidence cannot
 * silently become instrumental. CLAP cosine similarities are uncalibrated, so
 * they are not interpreted as probabilities or a source of legal authority.
 */
export const QUIET_READING_POLICY = "cove-quiet-reading-v2";
export type QuietReadingTier =
  "quiet_focus" | "gentle_background" | "distracting" | "needs_vocal_evidence";

export type QuietReadingAssessment = {
  policy: typeof QUIET_READING_POLICY;
  tier: QuietReadingTier;
  suitable: boolean;
  distraction: number;
  evidence: "full_signal_plus_sampled_semantics" | "full_signal_only";
  vocalEvidence:
    | "instrumental_metadata_and_model"
    | "instrumental_metadata_only"
    | "possible_vocals"
    | "unknown";
  features: {
    energy: number;
    abruptness: number;
    dynamics: number;
    transientDensity: number;
    climaxes: number;
    spectralNoise: number;
    semanticArousal: number | null;
  };
  reasons: string[];
};

const clamp = (n: number) =>
  Math.max(0, Math.min(1, Number.isFinite(n) ? n : 1));
const norm = (n: number, low: number, high: number) =>
  clamp((n - low) / (high - low));

export function assessQuietReading(
  report: MusicReport,
  hasVocals: boolean | null,
): QuietReadingAssessment {
  const s = report.signal;
  const semantic = report.semantics?.dimensions;
  const semanticCoverage =
    !!report.semantics &&
    report.semantics.windows.length >= 3 &&
    report.semantics.sampledSeconds >= 20;
  const vocal = semanticCoverage ? (semantic?.vocalPresence ?? null) : null;
  // The timeline and peaks are measured across the whole recording, not just
  // cherry-picked semantic windows or the label in a Commons category.
  const bins = report.structure.timeline;
  const sortedLoudness = bins.map((b) => b.rmsDbfs).sort((a, b) => a - b);
  const quantile = (p: number) =>
    sortedLoudness[
      Math.min(sortedLoudness.length - 1, Math.floor((sortedLoudness.length - 1) * p))
    ];
  const spread = sortedLoudness.length ? quantile(0.95) - quantile(0.05) : 100;
  const dynamics = Math.max(report.loudness.loudnessRangeLu, spread);
  const climaxSeconds = report.structure.climaxes.reduce((sum, [a, b]) => sum + b - a, 0);
  const climaxRatio = clamp(climaxSeconds / report.durationSeconds);
  const abruptness = clamp(s.abruptTransitionRate);
  const transients = norm(s.onsetsPerSecond, 0.6, 6);
  const arousal = semanticCoverage ? (semantic?.arousal ?? null) : null;
  const noise = clamp(s.spectralFlatness);
  const dynamicPenalty = norm(dynamics, 8, 29);
  const score = clamp(
    0.24 * clamp(s.energy) +
      0.19 * abruptness +
      0.16 * dynamicPenalty +
      0.11 * transients +
      0.1 * norm(climaxRatio, 0, 0.25) +
      0.08 * noise +
      0.08 * (arousal ?? clamp(s.energy)) +
      0.04 * norm(s.tonalEntropy, 0.25, 1),
  );
  const reasons: string[] = [];
  if (hasVocals === true || (vocal !== null && vocal >= 0.55)) reasons.push("likely_vocals");
  if (report.loudness.truePeakDbfs > 0) reasons.push("clipped_peak_risk");
  if (abruptness >= 0.7) reasons.push("frequent_abrupt_transitions");
  if (climaxRatio >= 0.4) reasons.push("sustained_climaxes");
  if (s.energy >= 0.9) reasons.push("very_high_energy");
  if (score > 0.6) reasons.push("high_distraction_score");
  // Instrumental metadata alone is admissible for acoustic recommendations,
  // but the result remains tagged as lower-evidence for future reanalysis.
  const unknownVocals = hasVocals !== false && (vocal === null || vocal > 0.2);
  if (unknownVocals && !reasons.includes("likely_vocals"))
    reasons.push("insufficient_vocal_evidence");
  const veto = reasons.some((r) => r !== "insufficient_vocal_evidence");
  const tier: QuietReadingTier = veto
    ? "distracting"
    : unknownVocals
      ? "needs_vocal_evidence"
      : score <= 0.34
        ? "quiet_focus"
        : score <= 0.6
          ? "gentle_background"
          : "distracting";
  return {
    policy: QUIET_READING_POLICY,
    tier,
    suitable: tier === "quiet_focus" || tier === "gentle_background",
    distraction: Number(score.toFixed(4)),
    evidence: semanticCoverage
      ? "full_signal_plus_sampled_semantics"
      : "full_signal_only",
    vocalEvidence:
      hasVocals === true || (vocal !== null && vocal >= 0.55)
        ? "possible_vocals"
        : hasVocals === false
          ? vocal !== null && vocal <= 0.2
            ? "instrumental_metadata_and_model"
            : "instrumental_metadata_only"
          : "unknown",
    features: {
      energy: s.energy,
      abruptness,
      dynamics: Number(dynamics.toFixed(2)),
      transientDensity: transients,
      climaxes: climaxRatio,
      spectralNoise: noise,
      semanticArousal: arousal,
    },
    reasons,
  };
}
