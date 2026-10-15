import { z } from "zod";

const note = z.string().trim().min(40).max(4000);
const source = z
  .string()
  .url()
  .max(1000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Evidence links must use HTTPS without credentials");
const layer = z.object({ basis: note, evidenceUrls: z.array(source).min(1).max(12) });
export const soundtrackDossierSchema = z
  .object({
    composition: layer,
    arrangement: layer,
    lyrics: layer,
    performance: layer,
    master: layer,
    grantingParty: z.string().trim().min(2).max(400),
    recordingDate: z.string().trim().min(4).max(100),
    territoryBasis: note,
    streamingBasis: note,
    attributionText: z.string().trim().min(10).max(3000),
    modificationNotice: z.string().trim().min(10).max(1000),
    reviewMethod: z.enum(["human", "ai_assisted", "source_license"]),
    sourceReliance: z
      .object({
        sourcePageUrl: source,
        sourceSha1: z.string().regex(/^[a-f0-9]{40}$/),
        licenseCode: z.enum(["PD", "CC0", "CC-BY", "CC-BY-SA"]),
        licenseUrl: source,
        declarationBasis: note,
      })
      .optional(),
    complexProvenance: z.boolean(),
    unresolved: z.array(z.string().trim().min(1).max(1000)).max(20),
  })
  .refine((value) => value.reviewMethod !== "source_license" || !!value.sourceReliance, {
    message:
      "Source-license reliance requires the exact recording and published license declaration",
  });
export type SoundtrackDossier = z.infer<typeof soundtrackDossierSchema>;
export const soundtrackQualitySchema = z.object({
  sourceSha1: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  durationSeconds: z.number().finite().positive().max(14400),
  channels: z.number().int().min(1).max(2),
  sampleRate: z.number().int().min(8000).max(192000),
  integratedLufs: z.number().finite().min(-70).max(0),
  truePeakDbfs: z.number().finite().min(-70).max(6),
  silenceRatio: z.number().finite().min(0).max(1),
  clippedSampleRatio: z.number().finite().min(0).max(1),
  decodedFully: z.literal(true),
  tool: z.string().min(4).max(500),
  measuredAt: z.string().datetime({ offset: true }),
});
export type SoundtrackQuality = z.infer<typeof soundtrackQualitySchema>;
export function qualityPasses(report: SoundtrackQuality) {
  // Screening limits, not a claim of human listening or mastering quality.
  return (
    report.integratedLufs >= -40 &&
    report.integratedLufs <= -8 &&
    report.truePeakDbfs <= 0 &&
    report.clippedSampleRatio < 0.001 &&
    report.silenceRatio < 0.25
  );
}
