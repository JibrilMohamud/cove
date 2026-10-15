import type { CatalogBook } from "./client";
import { getRecord, getRecords, putRecord, sha256 } from "./offline";

type PublicEpubDownload = {
  id: string;
  kind: "epub";
  complete: boolean;
  book: CatalogBook;
  assetIds: string[];
  sha256?: string;
};
export const publicEpubKey = (bookId: string) => `epub:${bookId}`;
function references(book: CatalogBook) {
  return [
    ...new Set(
      [String(book.id), book.publicProductId, book.sourceExternalId].filter(
        (v): v is string => !!v,
      ),
    ),
  ];
}
export function isPublicEpubBook(book: CatalogBook) {
  return (
    !book.uploaded &&
    (book.sourceName === "gutenberg" || (!book.sourceName && /^\d+$/.test(String(book.id))))
  );
}
export async function publicEpubDownload(bookId: string): Promise<PublicEpubDownload | null> {
  let record = await getRecord<PublicEpubDownload>("downloads", publicEpubKey(bookId));
  if (!record) {
    const alias = await getRecord<{ downloadId: string }>("assets", `public-epub-alias:${bookId}`);
    if (alias) record = await getRecord<PublicEpubDownload>("downloads", alias.downloadId);
    if (!record) {
      record = (await getRecords<PublicEpubDownload>("downloads")).find(
        (saved) =>
          saved.book && isPublicEpubBook(saved.book) && references(saved.book).includes(bookId),
      );
    }
  }
  if (
    !record ||
    record.kind !== "epub" ||
    !record.complete ||
    !record.book ||
    !isPublicEpubBook(record.book) ||
    !references(record.book).includes(bookId) ||
    record.id !== publicEpubKey(String(record.book.id))
  )
    return null;
  return record;
}
export async function publicEpubBytes(bookId: string) {
  const record = await publicEpubDownload(bookId);
  // Legacy numeric Gutenberg cache keys are unambiguously public. Canonical IDs require a manifest.
  const key = record
    ? publicEpubKey(String(record.book.id))
    : /^\d+$/.test(bookId)
      ? publicEpubKey(bookId)
      : null;
  if (!key || (record && !record.assetIds.includes(key))) return null;
  const asset = await getRecord<{ bytes?: ArrayBuffer; blob?: Blob; sha256?: string }>(
    "assets",
    key,
  );
  if (!asset?.bytes && !asset?.blob) return null;
  const bytes = asset.bytes || (await asset.blob!.arrayBuffer());
  const signature = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (signature[0] !== 0x50 || signature[1] !== 0x4b)
    throw new Error("The saved EPUB is damaged. Remove it and save it again.");
  const expected = record?.sha256 || asset.sha256;
  if (expected && (await sha256(bytes)) !== expected)
    throw new Error("Saved EPUB integrity check failed. Remove it and save it again.");
  return bytes;
}
export async function savePublicEpub(book: CatalogBook, bytes: ArrayBuffer) {
  if (!isPublicEpubBook(book))
    throw new Error("Only public Gutenberg editions use the shared offline EPUB cache.");
  const key = publicEpubKey(String(book.id)),
    checksum = await sha256(bytes);
  await putRecord("assets", {
    id: key,
    sha256: checksum,
    // Binary buffers clone reliably into private/ephemeral WebKit IndexedDB.
    // Continue reading legacy Blob records above for existing downloads.
    bytes,
  });
  await putRecord("downloads", {
    id: key,
    title: book.title,
    kind: "epub",
    book,
    sha256: checksum,
    bytes: bytes.byteLength,
    assetIds: [key, ...references(book).map((ref) => `public-epub-alias:${ref}`)],
    complete: true,
    updatedAt: new Date().toISOString(),
  });
  for (const ref of references(book))
    await putRecord("assets", { id: `public-epub-alias:${ref}`, downloadId: key });
}
