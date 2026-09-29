export const RATING_LABELS: Record<string, string> = {
  "0.5": "Lovingly, no",
  "1": "Bad",
  "1.5": "Bad (with Benefits)",
  "2": "Meh",
  "2.5": "Good (Enough)",
  "3": "Good",
  "3.5": "Great(ish)",
  "4": "Great",
  "4.5": "Practically Perfect",
  "5": "Perfect",
};
export const RATINGS = Array.from({ length: 10 }, (_, i) => (i + 1) / 2);
export function countWords(text: string) {
  return text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length || 0;
}
export type Review = {
  id: string;
  bookId: string;
  name: string;
  rating: number | null;
  body: string;
  visibility: "public" | "private";
  spoiler: boolean;
  wordCount: number;
  hearts: number;
  hearted: boolean;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
  provenance?: { type: "verified_purchase" | "subscription_reader" | "free_promotional_copy" | "gifted" | "sideloaded_unverified" | "publisher_author_copy"; verified: boolean };
};
export type Shelf = {
  id: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  count: number;
  updatedAt: string;
  version: number;
};
export type AudioTrack = {
  id: string;
  title: string;
  url: string;
  duration?: number;
  bytes?: number;
  sha256?: string;
  mime: string;
};
export type SyncCue = {
  trackId: string;
  start: number;
  end: number;
  href: string;
  cfi: string;
  endCfi: string;
  progress: number;
  endProgress: number;
  label: string;
};
export type Alignment = {
  version: 1 | 2;
  precision: "chapter" | "sentence" | "word";
  maps?: import("./biosync").TimingSummary[];
  verified: boolean;
  cues: SyncCue[];
};
export type AudioEdition = {
  id: string;
  gutenbergId: string;
  bookId: string | null;
  title: string;
  authors: { name: string }[];
  language: string;
  narration: "human" | "computer" | "unknown";
  narrator: string;
  sourceUrl: string;
  rights: string;
  tracks: AudioTrack[];
  alignment: Alignment | null;
  epubSha256: string | null;
  commercial?: boolean;
  productId?: string;
  publishingEditionId?: string;
  rightsTerritory?: string;
  audioPublisher?: string;
  copyrightNotice?: string;
  identifier?: { type: string; value: string };
  releaseDate?: string | null;
  subscriptionEligible?: boolean;
  offlineEligible?: boolean;
  previewAvailable?: boolean;
  offer?: { currency: string; amountMinor: number; type: string } | null;
  hasAccess?: boolean;
  narrators?: Array<{ id?: string; display_name?: string; displayName?: string; narration_type?: string; narrationType?: string }>;
  biosync?: { linkId: string; ebookProductId: string; coverageBps: number; timingSha256: string } | null;
};
export type Playback = {
  trackId: string;
  seconds: number;
  speed: number;
  version: number;
  updatedAt: string;
};
export function cueForText(edition: AudioEdition, progress: number) {
  if (!edition.alignment?.verified) return null;
  return (
    edition.alignment.cues.find((c) => progress >= c.progress && progress < c.endProgress) || null
  );
}
export function cueForAudio(edition: AudioEdition, trackId: string, seconds: number) {
  if (!edition.alignment?.verified) return null;
  return (
    edition.alignment.cues.find(
      (c) => c.trackId === trackId && seconds >= c.start && seconds < c.end,
    ) || null
  );
}
export function formatTime(seconds: number) {
  const n = Math.max(0, Math.floor(seconds));
  const minutes = String(Math.floor(n / 60) % 60).padStart(2, "0");
  return (
    (n >= 3600 ? Math.floor(n / 3600) + ":" : "") + minutes + ":" + String(n % 60).padStart(2, "0")
  );
}
