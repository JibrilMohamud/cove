import type { LibraryEntry, ReadingSession } from "@/lib/reading-data";

export type ReadingAnalytics = {
  totalSeconds: number;
  totalHours: number;
  wordsRead: number;
  wpm: number;
  pageTurns: number;
  pageTurnsPerHour: number;
  dailyAverageMinutes: number;
  streak: number;
  improvementPercent: number;
  activeDays: number;
  perBook: Array<{
    bookId: number;
    title: string;
    seconds: number;
    wordsRead: number;
    pageTurns: number;
  }>;
};

function dayKey(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function calculateReadingAnalytics(
  sessions: ReadingSession[],
  library: LibraryEntry[] = [],
): ReadingAnalytics {
  const totalSeconds = sessions.reduce((sum, s) => sum + Math.max(0, s.activeSeconds), 0);
  const wordsRead = sessions.reduce((sum, s) => sum + Math.max(0, s.wordsRead), 0);
  const pageTurns = sessions.reduce((sum, s) => sum + Math.max(0, s.pageTurns), 0);
  const minutes = totalSeconds / 60;
  const days = new Set(sessions.map((s) => dayKey(s.startedAt)));

  const today = new Date();
  let streak = 0;
  for (let offset = 0; offset < 3650; offset += 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    if (days.has(dayKey(date))) streak += 1;
    else if (offset === 0) continue;
    else break;
  }

  const nowMs = Date.now();
  const currentStart = nowMs - 7 * 86_400_000;
  const previousStart = nowMs - 14 * 86_400_000;
  const currentSeconds = sessions
    .filter((s) => new Date(s.startedAt).getTime() >= currentStart)
    .reduce((sum, s) => sum + s.activeSeconds, 0);
  const previousSeconds = sessions
    .filter((s) => {
      const time = new Date(s.startedAt).getTime();
      return time >= previousStart && time < currentStart;
    })
    .reduce((sum, s) => sum + s.activeSeconds, 0);
  const improvementPercent =
    previousSeconds > 0
      ? Math.round(((currentSeconds - previousSeconds) / previousSeconds) * 100)
      : 0;

  const perBookMap = new Map<number, ReadingAnalytics["perBook"][number]>();
  for (const session of sessions) {
    const existing = perBookMap.get(session.bookId) ?? {
      bookId: session.bookId,
      title: session.book.title,
      seconds: 0,
      wordsRead: 0,
      pageTurns: 0,
    };
    existing.seconds += session.activeSeconds;
    existing.wordsRead += session.wordsRead;
    existing.pageTurns += session.pageTurns;
    perBookMap.set(session.bookId, existing);
  }

  for (const entry of library) {
    if (!perBookMap.has(entry.bookId)) {
      perBookMap.set(entry.bookId, {
        bookId: entry.bookId,
        title: entry.book.title,
        seconds: 0,
        wordsRead: 0,
        pageTurns: 0,
      });
    }
  }

  return {
    totalSeconds,
    totalHours: totalSeconds / 3600,
    wordsRead,
    wpm: minutes > 0 ? Math.round(wordsRead / minutes) : 0,
    pageTurns,
    pageTurnsPerHour: totalSeconds > 0 ? Math.round(pageTurns / (totalSeconds / 3600)) : 0,
    dailyAverageMinutes: days.size > 0 ? Math.round(minutes / days.size) : 0,
    streak,
    improvementPercent,
    activeDays: days.size,
    perBook: Array.from(perBookMap.values()).sort((a, b) => b.seconds - a.seconds),
  };
}

export function formatReadingTime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.max(0, Math.round((seconds % 3600) / 60));
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
