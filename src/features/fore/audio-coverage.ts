import type { AudioEdition } from "./domain";
/** A map count is never a whole-book claim. Only maps pinned to the current
 * recording/text survive hydration; text completeness needs separate evidence.
 */
export function audioCoverage(edition: AudioEdition, storedTrackIds: readonly string[] = []) {
  const prepared = edition.tracks.filter(
    (t) =>
      /^[a-f0-9]{64}$/.test(t.sha256 || "") &&
      Number(t.duration) > 0 &&
      storedTrackIds.includes(t.id),
  );
  const checkedIds = new Set(
    edition.alignment?.verified && edition.alignment.version === 2
      ? (edition.alignment.maps || [])
          .filter((m) => /^[a-f0-9]{64}$/.test(m.sha256) && m.wordCount >= 30 && m.coverage >= 0.8)
          .map((m) => m.trackId)
      : [],
  );
  const checked = prepared.filter((t) => checkedIds.has(t.id));
  return {
    totalTracks: edition.tracks.length,
    preparedTracks: prepared.length,
    checkedTracks: checked.length,
    completeRecording: edition.tracks.length > 0 && prepared.length === edition.tracks.length,
    allTracksTimed: edition.tracks.length > 0 && checked.length === edition.tracks.length,
    // Exact-text alignment verifies spoken passages, not whether the recording
    // contains every chapter/word of the source EPUB (abridgments may align).
    wholeBookTextVerified: false,
  };
}
