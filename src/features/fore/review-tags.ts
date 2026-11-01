// Portable review labels. Until a dedicated owner-managed tag field is certified,
// tags are an optional, human-readable heading on the existing review body.
export const REVIEW_TAGS = {
  FirstRead: "First read",
  Reread: "Reread",
  DeepDive: "Deep dive",
  QuickTake: "Quick take",
  Audiobook: "Audiobook",
  DNF: "Did not finish",
  Humor: "Humor",
} as const;
export type ReviewTag = keyof typeof REVIEW_TAGS;
export const REVIEW_TAG_KEYS = Object.keys(REVIEW_TAGS) as ReviewTag[];

export function serializeTaggedReview(body: string, tags: readonly ReviewTag[]): string {
  const valid = [...new Set(tags)].filter((tag) => tag in REVIEW_TAGS).slice(0, 3);
  return body.trim() && valid.length
    ? valid.map((tag) => `#${tag}`).join(" ") + "\n\n" + body
    : body;
}

export function parseTaggedReview(raw: string): { body: string; tags: ReviewTag[] } {
  const match = /^(#[A-Za-z]+(?: #[A-Za-z]+){0,2})\n\n/.exec(raw);
  if (!match) return { body: raw, tags: [] };
  const tags = match[1].split(" ").map((token) => token.slice(1)) as ReviewTag[];
  if (!tags.every((tag) => tag in REVIEW_TAGS) || new Set(tags).size !== tags.length)
    return { body: raw, tags: [] };
  return { body: raw.slice(match[0].length), tags };
}
