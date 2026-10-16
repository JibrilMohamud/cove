import { z } from "zod";
export const MUSIC_POLICY = "cove-music-v1";
export const CLAP_MODEL = "laion/clap-htsat-unfused";
export const CLAP_REVISION = "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a";
const unit = z.number().finite().min(0).max(1);
const numeric = z.number().finite();
const tags = z.array(z.string().trim().min(1).max(100)).max(20);
export const musicSemanticSchema = z
  .object({
    model: z.literal(CLAP_MODEL),
    revision: z.literal(CLAP_REVISION),
    method: z.literal("zero_shot_audio_text_similarity"),
    scoreMeaning: z.literal("uncalibrated_cosine_similarity"),
    sampledSeconds: numeric.positive().max(80.000001),
    windows: z
      .array(z.object({ start: numeric.min(0), end: numeric.positive() }).strict())
      .min(1)
      .max(8),
    moods: z
      .array(
        z
          .object({ label: z.string().min(1).max(100), similarity: numeric.min(-1).max(1) })
          .strict(),
      )
      .max(20),
    nuance: tags,
    dimensions: z
      .object({
        valence: unit.nullable(),
        arousal: unit.nullable(),
        acousticness: unit.nullable(),
        vocalPresence: unit.nullable(),
        ensembleSize: z.enum(["solo", "chamber", "orchestra", "unknown"]),
        scale: z.enum(["intimate", "grand", "unknown"]),
        texture: tags,
        instruments: tags,
      })
      .strict(),
    confidence: unit.max(0.6),
  })
  .strict();
export const musicReportSchema = z
  .object({
    policy: z.literal(MUSIC_POLICY),
    sourceSha1: z.string().regex(/^[a-f0-9]{40}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z
      .number()
      .int()
      .positive()
      .max(25 * 1024 * 1024),
    durationSeconds: numeric.positive().max(7200),
    decodedFully: z.literal(true),
    analyzer: z.string().min(1).max(200),
    measuredAt: z.string().datetime({ offset: true }),
    loudness: z
      .object({
        integratedLufs: numeric.min(-100).max(10),
        truePeakDbfs: numeric.min(-150).max(20),
        loudnessRangeLu: numeric.min(0).max(100),
        rmsDynamicRangeDb: numeric.min(0).max(150),
      })
      .strict(),
    signal: z
      .object({
        spectralCentroidHz: numeric.min(0).max(24000),
        spectralRolloffHz: numeric.min(0).max(24000),
        spectralFlatness: unit,
        zeroCrossingRate: unit,
        onsetsPerSecond: numeric.min(0).max(100),
        tempoBpm: numeric.min(20).max(300).nullable(),
        tempoConfidence: unit,
        tonalEntropy: unit,
        abruptTransitionRate: unit,
        rhythmicActivity: unit,
        energy: unit,
      })
      .strict(),
    structure: z
      .object({
        binSeconds: numeric.positive().max(60),
        timeline: z
          .array(
            z
              .object({
                start: numeric.min(0),
                end: numeric.positive(),
                rmsDbfs: numeric.min(-150).max(10),
                centroidHz: numeric.min(0).max(24000),
                onsets: numeric.min(0).max(1000),
              })
              .strict(),
          )
          .min(1)
          .max(1440),
        quietSections: z.array(z.tuple([numeric.min(0), numeric.positive()])).max(64),
        climaxes: z.array(z.tuple([numeric.min(0), numeric.positive()])).max(64),
        transitionPoints: z.array(numeric.min(0)).max(64),
      })
      .strict(),
    semantics: musicSemanticSchema.nullable(),
    limitations: z.array(z.string().trim().min(1).max(400)).max(20),
  })
  .strict();
export type MusicReport = z.infer<typeof musicReportSchema>;
export function validateMusicReport(input: unknown) {
  const r = musicReportSchema.parse(input);
  const duration = r.durationSeconds;
  let end = 0;
  for (const bin of r.structure.timeline) {
    if (Math.abs(bin.start - end) > 0.1 || bin.end <= bin.start || bin.end > duration + 0.1)
      throw new Error("Invalid audio timeline coverage");
    end = bin.end;
  }
  if (Math.abs(end - duration) > 0.2) throw new Error("Incomplete audio timeline");
  for (const [start, end] of [...r.structure.quietSections, ...r.structure.climaxes])
    if (start >= end || end > duration + 0.1) throw new Error("Invalid music section bounds");
  for (const t of r.structure.transitionPoints)
    if (t > duration) throw new Error("Invalid transition point");
  if (r.semantics) {
    let previousEnd = 0,
      total = 0;
    for (const w of r.semantics.windows) {
      if (
        w.end <= w.start ||
        w.end - w.start > 10.1 ||
        w.start + 0.000001 < previousEnd ||
        w.end > duration + 0.1
      )
        throw new Error("Invalid model sample coverage");
      total += w.end - w.start;
      previousEnd = w.end;
    }
    if (Math.abs(total - r.semantics.sampledSeconds) > 0.2)
      throw new Error("Model sample duration mismatch");
  }
  return r;
}
