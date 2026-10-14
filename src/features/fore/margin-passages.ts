/** Identical words at different EPUB locations are independent conversations. */
export function marginLocationKey(
  cfi: string | null | undefined,
  quoteHash: string,
  fallback: string,
) {
  return JSON.stringify([cfi || `unanchored:${fallback}`, quoteHash]);
}

type PublishedHighlight = {
  id: string;
  annotationId: string;
  shareNote: boolean;
  updatedAt: string;
};

/** Paging into older publications must not replace the newest visible note. */
export function mergeMarginHighlights<T extends PublishedHighlight>(previous: T[], incoming: T[]) {
  const result = new Map<string, T>();
  for (const item of [...previous, ...incoming]) {
    const existing = result.get(item.annotationId);
    if (
      !existing ||
      (item.shareNote && !existing.shareNote) ||
      (item.shareNote === existing.shareNote &&
        (item.updatedAt > existing.updatedAt ||
          (item.updatedAt === existing.updatedAt && item.id > existing.id)))
    )
      result.set(item.annotationId, item);
  }
  return [...result.values()];
}
