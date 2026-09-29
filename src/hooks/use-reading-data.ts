import { useCallback, useEffect, useRef, useState } from "react";
import {
  getBookmarks,
  getHighlights,
  getLibraryEntries,
  getLibraryEntry,
  getReadingSessions,
  getShelves,
  subscribeReadingData,
  type Bookmark,
  type Highlight,
  type LibraryEntry,
  type ReadingSession,
  type Shelf,
} from "@/lib/reading-data";

function useLocalQuery<T>(loader: () => Promise<T>, initial: T, refreshKey?: unknown) {
  const [data, setData] = useState<T>(initial);
  const [isLoading, setIsLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refresh = useCallback(async () => {
    const result = await loaderRef.current();
    setData(result);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeReadingData(() => void refresh());
  }, [refresh, refreshKey]);

  return { data, isLoading, refresh };
}

export function useLibraryEntries() {
  return useLocalQuery<LibraryEntry[]>(getLibraryEntries, []);
}

export function useLibraryEntry(bookId: number) {
  return useLocalQuery<LibraryEntry | undefined>(() => getLibraryEntry(bookId), undefined, [
    bookId,
  ]);
}

export function useHighlights(bookId?: number) {
  return useLocalQuery<Highlight[]>(() => getHighlights(bookId), [], bookId);
}

export function useBookmarks(bookId?: number) {
  return useLocalQuery<Bookmark[]>(() => getBookmarks(bookId), [], bookId);
}

export function useReadingSessions() {
  return useLocalQuery<ReadingSession[]>(getReadingSessions, []);
}

export function useShelves() {
  return useLocalQuery<Shelf[]>(getShelves, []);
}
