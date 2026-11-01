// Readable, schema-free marker for opt-in Community Arena posts.
// Arena posts use Cove's existing, moderated profile-thread infrastructure.
export const ARENA_KINDS = {
  take: "Hot Take",
  debate: "Debate",
  matchup: "Tournament matchup",
} as const;
export type ArenaKind = keyof typeof ARENA_KINDS;
const marker = /^\[COVE-ARENA:(take|debate|matchup)(?::([A-Za-z0-9_-]{1,100}))?\]\n/;

export function makeArenaPost(kind: ArenaKind, text: string, bookId = ""): string {
  const safeBook = /^[A-Za-z0-9_-]{1,100}$/.test(bookId) ? bookId : "";
  return `[COVE-ARENA:${kind}${safeBook ? ":" + safeBook : ""}]\n${text.trim()}`;
}

export function readArenaPost(raw: string):
  | { kind: ArenaKind; bookId: string; text: string }
  | null {
  const match = marker.exec(raw);
  if (!match || !raw.slice(match[0].length).trim()) return null;
  return {
    kind: match[1] as ArenaKind,
    bookId: match[2] || "",
    text: raw.slice(match[0].length),
  };
}
