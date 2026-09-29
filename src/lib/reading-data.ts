/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase generated types are regenerated after applying the accompanying migration. */
import type { Book } from "@/lib/books";
import { getSupabaseClient } from "@/integrations/supabase/client";
import { dbGet, dbGetAll, dbPut, dbPutMany } from "@/lib/local-db";

export type ReadingStatus = "want-to-read" | "reading" | "finished";
export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";

export type BookSnapshot = {
  id: number;
  title: string;
  author: string;
  coverUrl: string | null;
  categories: string[];
  languages: string[];
};

export type LibraryEntry = {
  bookId: number;
  book: BookSnapshot;
  status: ReadingStatus;
  progress: number;
  currentPage: number;
  totalPages: number;
  shelves: string[];
  tags: string[];
  rating: number | null;
  review: string;
  addedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastReadAt: string | null;
  updatedAt: string;
  deletedAt?: string | null;
};

export type Highlight = {
  id: string;
  bookId: number;
  book: BookSnapshot;
  quote: string;
  color: HighlightColor;
  noteHtml: string;
  page: number;
  progress: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};

export type Bookmark = {
  id: string;
  bookId: number;
  book: BookSnapshot;
  page: number;
  progress: number;
  label: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};

export type ReadingSession = {
  id: string;
  bookId: number;
  book: BookSnapshot;
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  wordsRead: number;
  pageTurns: number;
  startProgress: number;
  endProgress: number;
  updatedAt: string;
};

export type Shelf = {
  id: string;
  name: string;
  emoji: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};

export type CachedBookContent = {
  bookId: number;
  text: string;
  cachedAt: string;
  source: "network" | "import";
};

const CHANGE_EVENT = "fore:reading-data-change";
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncInFlight: Promise<void> | null = null;

export function snapshotBook(book: Book): BookSnapshot {
  return {
    id: book.id,
    title: book.title,
    author: book.authors?.[0]?.name ?? "Unknown",
    coverUrl: book.cover_url,
    categories: book.categories ?? [],
    languages: book.languages ?? [],
  };
}

function now() {
  return new Date().toISOString();
}

function uuid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function subscribeReadingData(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

function scheduleSync() {
  if (typeof window === "undefined") return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void syncReadingData();
  }, 800);
}

export async function getLibraryEntries(): Promise<LibraryEntry[]> {
  const entries = await dbGetAll<LibraryEntry>("library");
  return entries
    .filter((entry) => !entry.deletedAt)
    .sort((a, b) => (b.lastReadAt ?? b.updatedAt).localeCompare(a.lastReadAt ?? a.updatedAt));
}

export async function getLibraryEntry(bookId: number): Promise<LibraryEntry | undefined> {
  const entry = await dbGet<LibraryEntry>("library", bookId);
  return entry?.deletedAt ? undefined : entry;
}

export async function upsertLibraryEntry(
  book: Book,
  patch: Partial<Omit<LibraryEntry, "bookId" | "book" | "addedAt" | "updatedAt">> = {},
): Promise<LibraryEntry> {
  const existing = await dbGet<LibraryEntry>("library", book.id);
  const timestamp = now();
  const status = patch.status ?? existing?.status ?? "want-to-read";
  const entry: LibraryEntry = {
    bookId: book.id,
    book: snapshotBook(book),
    status,
    progress: patch.progress ?? existing?.progress ?? 0,
    currentPage: patch.currentPage ?? existing?.currentPage ?? 1,
    totalPages: patch.totalPages ?? existing?.totalPages ?? 1,
    shelves: patch.shelves ?? existing?.shelves ?? [],
    tags: patch.tags ?? existing?.tags ?? [],
    rating: patch.rating ?? existing?.rating ?? null,
    review: patch.review ?? existing?.review ?? "",
    addedAt: existing?.addedAt ?? timestamp,
    startedAt: patch.startedAt ?? existing?.startedAt ?? (status === "reading" ? timestamp : null),
    finishedAt:
      patch.finishedAt ?? existing?.finishedAt ?? (status === "finished" ? timestamp : null),
    lastReadAt: patch.lastReadAt ?? existing?.lastReadAt ?? null,
    updatedAt: timestamp,
    deletedAt: null,
  };
  await dbPut("library", entry);
  notify();
  scheduleSync();
  return entry;
}

export async function removeFromLibrary(bookId: number): Promise<void> {
  const existing = await dbGet<LibraryEntry>("library", bookId);
  if (!existing) return;
  await dbPut("library", { ...existing, deletedAt: now(), updatedAt: now() });
  notify();
  scheduleSync();
}

export async function updateReadingProgress(
  book: Book,
  progress: number,
  currentPage: number,
  totalPages: number,
): Promise<LibraryEntry> {
  const clamped = Math.max(0, Math.min(1, progress));
  const status: ReadingStatus = clamped >= 0.995 ? "finished" : "reading";
  return upsertLibraryEntry(book, {
    progress: clamped,
    currentPage,
    totalPages,
    status,
    startedAt: (await getLibraryEntry(book.id))?.startedAt ?? now(),
    finishedAt: status === "finished" ? now() : null,
    lastReadAt: now(),
  });
}

export async function saveBookReview(book: Book, rating: number | null, review: string) {
  const entry = await upsertLibraryEntry(book, { rating, review });
  scheduleSync();
  return entry;
}

export async function getHighlights(bookId?: number): Promise<Highlight[]> {
  const highlights = await dbGetAll<Highlight>("highlights");
  return highlights
    .filter((highlight) => !highlight.deletedAt && (bookId == null || highlight.bookId === bookId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createHighlight(input: {
  book: Book;
  quote: string;
  color: HighlightColor;
  noteHtml?: string;
  page: number;
  progress: number;
}): Promise<Highlight> {
  const timestamp = now();
  const highlight: Highlight = {
    id: uuid(),
    bookId: input.book.id,
    book: snapshotBook(input.book),
    quote: input.quote.trim(),
    color: input.color,
    noteHtml: input.noteHtml ?? "",
    page: input.page,
    progress: input.progress,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
  await dbPut("highlights", highlight);
  notify();
  scheduleSync();
  return highlight;
}

export async function updateHighlight(
  id: string,
  patch: Partial<Pick<Highlight, "color" | "noteHtml">>,
) {
  const existing = await dbGet<Highlight>("highlights", id);
  if (!existing) return;
  await dbPut("highlights", { ...existing, ...patch, updatedAt: now() });
  notify();
  scheduleSync();
}

export async function deleteHighlight(id: string) {
  const existing = await dbGet<Highlight>("highlights", id);
  if (!existing) return;
  await dbPut("highlights", { ...existing, deletedAt: now(), updatedAt: now() });
  notify();
  scheduleSync();
}

export async function getBookmarks(bookId?: number): Promise<Bookmark[]> {
  const bookmarks = await dbGetAll<Bookmark>("bookmarks");
  return bookmarks.filter(
    (bookmark) => !bookmark.deletedAt && (bookId == null || bookmark.bookId === bookId),
  );
}

export async function toggleBookmark(book: Book, page: number, progress: number): Promise<boolean> {
  const all = await dbGetAll<Bookmark>("bookmarks");
  const existing = all.find(
    (bookmark) => !bookmark.deletedAt && bookmark.bookId === book.id && bookmark.page === page,
  );
  if (existing) {
    await dbPut("bookmarks", { ...existing, deletedAt: now(), updatedAt: now() });
    notify();
    scheduleSync();
    return false;
  }
  const timestamp = now();
  const bookmark: Bookmark = {
    id: uuid(),
    bookId: book.id,
    book: snapshotBook(book),
    page,
    progress,
    label: `Page ${page}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
  await dbPut("bookmarks", bookmark);
  notify();
  scheduleSync();
  return true;
}

export async function recordReadingSession(session: Omit<ReadingSession, "id" | "updatedAt">) {
  if (session.activeSeconds < 2) return;
  const row: ReadingSession = { ...session, id: uuid(), updatedAt: now() };
  await dbPut("sessions", row);
  notify();
  scheduleSync();
}

export async function getReadingSessions(): Promise<ReadingSession[]> {
  return (await dbGetAll<ReadingSession>("sessions")).sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}

export async function getShelves(): Promise<Shelf[]> {
  return (await dbGetAll<Shelf>("shelves"))
    .filter((shelf) => !shelf.deletedAt)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createShelf(name: string, emoji = "📚"): Promise<Shelf> {
  const timestamp = now();
  const shelf: Shelf = {
    id: uuid(),
    name: name.trim(),
    emoji,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await dbPut("shelves", shelf);
  notify();
  scheduleSync();
  return shelf;
}

export async function setBookShelves(book: Book, shelves: string[]) {
  return upsertLibraryEntry(book, { shelves: Array.from(new Set(shelves)) });
}

export async function cacheBookContent(
  bookId: number,
  text: string,
  source: CachedBookContent["source"] = "network",
) {
  await dbPut<CachedBookContent>("contents", { bookId, text, source, cachedAt: now() });
  notify();
}

export async function getCachedBookContent(bookId: number) {
  return dbGet<CachedBookContent>("contents", bookId);
}

export async function downloadBookForOffline(bookId: number): Promise<CachedBookContent> {
  const cached = await getCachedBookContent(bookId);
  if (cached?.text) return cached;
  const response = await fetch(`/api/public/books/${bookId}/content`);
  if (!response.ok) throw new Error("This edition could not be downloaded for offline reading.");
  const text = await response.text();
  await cacheBookContent(bookId, text);
  return { bookId, text, source: "network", cachedAt: now() };
}

export async function syncReadingData(): Promise<void> {
  if (typeof window === "undefined" || !navigator.onLine) return;
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    const client = getSupabaseClient();
    if (!client) return;
    const { data } = await client.auth.getSession();
    const user = data.session?.user;
    if (!user) return;
    const db = client as any;

    const [library, highlights, bookmarks, sessions, shelves] = await Promise.all([
      dbGetAll<LibraryEntry>("library"),
      dbGetAll<Highlight>("highlights"),
      dbGetAll<Bookmark>("bookmarks"),
      dbGetAll<ReadingSession>("sessions"),
      dbGetAll<Shelf>("shelves"),
    ]);

    const upserts = [
      library.length
        ? db.from("user_library").upsert(
            library.map((entry) => ({
              user_id: user.id,
              book_id: entry.bookId,
              book_snapshot: entry.book,
              status: entry.status,
              progress: entry.progress,
              current_page: entry.currentPage,
              total_pages: entry.totalPages,
              shelves: entry.shelves,
              tags: entry.tags,
              rating: entry.rating,
              review: entry.review,
              added_at: entry.addedAt,
              started_at: entry.startedAt,
              finished_at: entry.finishedAt,
              last_read_at: entry.lastReadAt,
              updated_at: entry.updatedAt,
              deleted_at: entry.deletedAt ?? null,
            })),
            { onConflict: "user_id,book_id" },
          )
        : Promise.resolve({ error: null }),
      highlights.length
        ? db.from("highlights").upsert(
            highlights.map((h) => ({
              id: h.id,
              user_id: user.id,
              book_id: h.bookId,
              book_snapshot: h.book,
              quote: h.quote,
              color: h.color,
              note_html: h.noteHtml,
              page: h.page,
              progress: h.progress,
              created_at: h.createdAt,
              updated_at: h.updatedAt,
              deleted_at: h.deletedAt ?? null,
            })),
          )
        : Promise.resolve({ error: null }),
      bookmarks.length
        ? db.from("bookmarks").upsert(
            bookmarks.map((b) => ({
              id: b.id,
              user_id: user.id,
              book_id: b.bookId,
              book_snapshot: b.book,
              page: b.page,
              progress: b.progress,
              label: b.label,
              created_at: b.createdAt,
              updated_at: b.updatedAt,
              deleted_at: b.deletedAt ?? null,
            })),
          )
        : Promise.resolve({ error: null }),
      sessions.length
        ? db.from("reading_sessions").upsert(
            sessions.map((s) => ({
              id: s.id,
              user_id: user.id,
              book_id: s.bookId,
              book_snapshot: s.book,
              started_at: s.startedAt,
              ended_at: s.endedAt,
              active_seconds: s.activeSeconds,
              words_read: s.wordsRead,
              page_turns: s.pageTurns,
              start_progress: s.startProgress,
              end_progress: s.endProgress,
              updated_at: s.updatedAt,
            })),
          )
        : Promise.resolve({ error: null }),
      shelves.length
        ? db.from("shelves").upsert(
            shelves.map((s) => ({
              id: s.id,
              user_id: user.id,
              name: s.name,
              emoji: s.emoji,
              created_at: s.createdAt,
              updated_at: s.updatedAt,
              deleted_at: s.deletedAt ?? null,
            })),
          )
        : Promise.resolve({ error: null }),
    ];

    const results = await Promise.all(upserts);
    const failed = results.find((result: any) => result?.error)?.error;
    if (failed) throw failed;

    const [remoteLibrary, remoteHighlights, remoteBookmarks, remoteSessions, remoteShelves] =
      await Promise.all([
        db.from("user_library").select("*").eq("user_id", user.id),
        db.from("highlights").select("*").eq("user_id", user.id),
        db.from("bookmarks").select("*").eq("user_id", user.id),
        db.from("reading_sessions").select("*").eq("user_id", user.id),
        db.from("shelves").select("*").eq("user_id", user.id),
      ]);

    const localLibrary = new Map(library.map((row) => [row.bookId, row]));
    const mergedLibrary: LibraryEntry[] = (remoteLibrary.data ?? []).map((row: any) => {
      const remote: LibraryEntry = {
        bookId: Number(row.book_id),
        book: row.book_snapshot,
        status: row.status,
        progress: Number(row.progress ?? 0),
        currentPage: row.current_page ?? 1,
        totalPages: row.total_pages ?? 1,
        shelves: row.shelves ?? [],
        tags: row.tags ?? [],
        rating: row.rating,
        review: row.review ?? "",
        addedAt: row.added_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        lastReadAt: row.last_read_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
      };
      const local = localLibrary.get(remote.bookId);
      return local && local.updatedAt > remote.updatedAt ? local : remote;
    });

    const mapRemote = <T extends { id: string; updatedAt: string }>(
      localRows: T[],
      remoteRows: any[],
      transform: (row: any) => T,
    ) => {
      const localMap = new Map(localRows.map((row) => [row.id, row]));
      return remoteRows.map((row) => {
        const remote = transform(row);
        const local = localMap.get(remote.id);
        return local && local.updatedAt > remote.updatedAt ? local : remote;
      });
    };

    await Promise.all([
      dbPutMany("library", mergedLibrary),
      dbPutMany(
        "highlights",
        mapRemote(highlights, remoteHighlights.data ?? [], (row) => ({
          id: row.id,
          bookId: Number(row.book_id),
          book: row.book_snapshot,
          quote: row.quote,
          color: row.color,
          noteHtml: row.note_html ?? "",
          page: row.page,
          progress: Number(row.progress ?? 0),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deletedAt: row.deleted_at,
        })),
      ),
      dbPutMany(
        "bookmarks",
        mapRemote(bookmarks, remoteBookmarks.data ?? [], (row) => ({
          id: row.id,
          bookId: Number(row.book_id),
          book: row.book_snapshot,
          page: row.page,
          progress: Number(row.progress ?? 0),
          label: row.label,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deletedAt: row.deleted_at,
        })),
      ),
      dbPutMany(
        "sessions",
        mapRemote(sessions, remoteSessions.data ?? [], (row) => ({
          id: row.id,
          bookId: Number(row.book_id),
          book: row.book_snapshot,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          activeSeconds: row.active_seconds,
          wordsRead: row.words_read,
          pageTurns: row.page_turns,
          startProgress: Number(row.start_progress ?? 0),
          endProgress: Number(row.end_progress ?? 0),
          updatedAt: row.updated_at,
        })),
      ),
      dbPutMany(
        "shelves",
        mapRemote(shelves, remoteShelves.data ?? [], (row) => ({
          id: row.id,
          name: row.name,
          emoji: row.emoji,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deletedAt: row.deleted_at,
        })),
      ),
    ]);

    const reviewed = library.filter((entry) => entry.rating || entry.review.trim());
    if (reviewed.length) {
      await db.from("book_reviews").upsert(
        reviewed.map((entry) => ({
          user_id: user.id,
          book_id: entry.bookId,
          rating: entry.rating,
          review: entry.review,
          updated_at: entry.updatedAt,
          deleted_at: entry.deletedAt ?? null,
        })),
        { onConflict: "user_id,book_id" },
      );
    }

    notify();
  })()
    .catch((error) => console.warn("Cove sync deferred:", error))
    .finally(() => {
      syncInFlight = null;
    });

  return syncInFlight;
}
