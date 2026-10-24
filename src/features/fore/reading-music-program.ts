/**
 * Deterministic offline playlist programming. Operates on an already
 * rights-filtered, precomputed catalog snapshot; it never grants territory,
 * storage or entitlement rights and must not query primary D1 per listener.
 *
 * Track identity is a recording/master, not a work or title: alternate
 * performances are distinct but repeated fingerprint/audio masters are not.
 */
export type ReadingTrack = {
  id: string;
  durationSeconds: number;
  suitability: "quiet_focus" | "gentle_background";
  composer: string;
  performer: string;
  masterFingerprint: string;
  /** Canonical composition/work identifier if known; never infer it from title. */
  workKey?: string;
  era?: string;
  affinity?: number;
  playsLast30Days?: number;
};
export type ReadingProgramOptions = {
  sessionSeed: string;
  desiredMinutes?: number;
  recentRecordingIds?: readonly string[];
  recentMasterFingerprints?: readonly string[];
  recentWorkKeys?: readonly string[];
  maxComposerShare?: number;
};

function hash(seed: string): number {
  let value = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

const validId = (v: string) => v.length > 0 && v.length <= 256;
const normalize = (s: string) => s.toLowerCase().trim() || "unknown";

/**
 * Balance book affinity and freshness while avoiding a dominant composer.
 * Relax recent-track and composer constraints only when the rights-filtered
 * selection pool cannot satisfy the session length. Never repeat a master in
 * the same playlist, even when it has multiple catalog IDs.
 */
export function planDiverseReadingMusic(
  tracks: readonly ReadingTrack[],
  options: ReadingProgramOptions,
): ReadingTrack[] {
  const target = Math.max(5, Math.min(240, options.desiredMinutes ?? 45)) * 60;
  const maxShare = Math.max(0.2, Math.min(0.8, options.maxComposerShare ?? 0.3));
  const recentIds = new Set(options.recentRecordingIds ?? []);
  const recentMasters = new Set(options.recentMasterFingerprints ?? []);
  const recentWorks = new Set(options.recentWorkKeys ?? []);
  const selected: ReadingTrack[] = [];
  const usedMasters = new Set<string>();
  const usedWorks = new Set<string>();
  const usedIds = new Set<string>();
  const composers = new Map<string, number>();
  const pool = tracks.filter(
    (t) =>
      validId(t.id) &&
      validId(t.masterFingerprint) &&
      Number.isFinite(t.durationSeconds) &&
      t.durationSeconds >= 30 &&
      t.durationSeconds <= 7200,
  );
  let duration = 0;
  for (const relax of [0, 1, 2]) {
    while (duration < target) {
      const eligible = pool.filter((t) => {
        if (usedIds.has(t.id) || usedMasters.has(t.masterFingerprint)) return false;
        if (relax < 2 && t.workKey && usedWorks.has(t.workKey)) return false;
        if (relax < 2 && t.workKey && recentWorks.has(t.workKey)) return false;
        if (relax < 2 && (recentIds.has(t.id) || recentMasters.has(t.masterFingerprint)))
          return false;
        const composer = normalize(t.composer);
        const newSeconds = (composers.get(composer) ?? 0) + t.durationSeconds;
        if (
          relax < 1 &&
          (composers.get(composer) ?? 0) > 0 &&
          newSeconds / (duration + t.durationSeconds) > maxShare
        )
          return false;
        return true;
      });
      if (!eligible.length) break;
      eligible.sort((a, b) => {
        const priority = (t: ReadingTrack) => {
          const freshness = 1 / (1 + Math.max(0, t.playsLast30Days ?? 0));
          const quietness = t.suitability === "quiet_focus" ? 0.15 : 0;
          const affinity = Math.max(0, Math.min(1, t.affinity ?? 0.5));
          return 0.5 * affinity + 0.35 * freshness + quietness;
        };
        const da = priority(a),
          db = priority(b);
        if (db !== da) return db - da;
        return hash(options.sessionSeed + ":" + a.id) - hash(options.sessionSeed + ":" + b.id);
      });
      const next = eligible[0];
      selected.push(next);
      usedIds.add(next.id);
      usedMasters.add(next.masterFingerprint);
      if (next.workKey) usedWorks.add(next.workKey);
      const c = normalize(next.composer);
      composers.set(c, (composers.get(c) ?? 0) + next.durationSeconds);
      duration += next.durationSeconds;
    }
    if (duration >= target) break;
  }
  return selected;
}
