/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase generated types are regenerated after applying the accompanying migration. */
// Resumable Gutendex ingestion. Each run imports exactly the API page stored in
// ingest_state, then advances to Gutendex's own `next` URL. EPUB binaries are
// downloaded by a bounded worker so a single cron invocation cannot exhaust
// memory or request limits.

type GutendexAuthor = { name: string; birth_year: number | null; death_year: number | null };
type GutendexBook = {
  id: number;
  title: string;
  authors: GutendexAuthor[];
  translators: GutendexAuthor[];
  summaries?: string[];
  subjects: string[];
  bookshelves: string[];
  languages: string[];
  formats: Record<string, string>;
  download_count: number;
};

type GutendexPage = {
  count: number;
  next: string | null;
  previous: string | null;
  results: GutendexBook[];
};

export type IngestResult = {
  page: number;
  sourceUrl: string;
  fetched: number;
  inserted: number;
  queuedEpubs: number;
  nextUrl: string | null;
  complete: boolean;
  skipped?: boolean;
};

export type EpubWorkerResult = {
  attempted: number;
  downloaded: number;
  failed: number;
};

const FIRST_PAGE = "https://gutendex.com/books/?copyright=false";
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

function pageFromUrl(url: string) {
  try {
    return Number(new URL(url).searchParams.get("page") ?? 1);
  } catch {
    return 1;
  }
}

function epubFormat(formats: Record<string, string>) {
  return (
    formats["application/epub+zip"] ??
    Object.entries(formats).find(([key]) => key.startsWith("application/epub"))?.[1] ??
    null
  );
}

function textFormat(formats: Record<string, string>) {
  return (
    formats["text/plain; charset=utf-8"] ??
    formats["text/plain; charset=us-ascii"] ??
    Object.entries(formats).find(([key]) => key.startsWith("text/plain"))?.[1] ??
    null
  );
}

function deriveCategories(book: GutendexBook) {
  const shelfNames = book.bookshelves
    .map((value) => value.replace(/^(Browsing|Category):\s*/i, "").trim())
    .filter((value) => value && !/^best books ever listings$/i.test(value));
  const subjectNames = book.subjects
    .map((value) => value.split(" -- ")[0]?.trim())
    .filter((value): value is string => Boolean(value) && value.length <= 70);
  return Array.from(new Set([...shelfNames, ...subjectNames])).slice(0, 16);
}

export async function runIngest(): Promise<IngestResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;
  const { data: state, error: stateError } = await db
    .from("ingest_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (stateError) throw stateError;

  const completedAt = state?.completed_at ? new Date(state.completed_at).getTime() : 0;
  if (!state?.next_url && completedAt && Date.now() - completedAt < REFRESH_AFTER_MS) {
    return {
      page: state.next_page ?? 1,
      sourceUrl: FIRST_PAGE,
      fetched: 0,
      inserted: 0,
      queuedEpubs: 0,
      nextUrl: null,
      complete: true,
      skipped: true,
    };
  }

  const sourceUrl = state?.next_url || FIRST_PAGE;
  const page = pageFromUrl(sourceUrl);
  const response = await fetch(sourceUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "CoveReader/1.0 (+Gutendex public-domain ingestion)",
    },
  });
  if (!response.ok) throw new Error(`Gutendex ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as GutendexPage;

  const rows = json.results.map((book) => {
    const epubSource = epubFormat(book.formats);
    return {
      id: book.id,
      title: book.title,
      authors: book.authors,
      translators: book.translators,
      summary: book.summaries?.[0] ?? null,
      categories: deriveCategories(book),
      languages: book.languages,
      cover_url: book.formats["image/jpeg"] ?? null,
      epub_source_url: epubSource,
      // Keep a usable upstream link until the binary worker replaces it with
      // the local Supabase Storage URL.
      epub_url: epubSource,
      html_url: book.formats["text/html"] ?? null,
      text_url: textFormat(book.formats),
      download_count: book.download_count,
      source_updated_at: new Date().toISOString(),
    };
  });

  const readable = rows.filter((row) => row.epub_source_url || row.text_url || row.html_url);
  const { error: upsertError } = await db.from("books").upsert(readable, { onConflict: "id" });
  if (upsertError) throw upsertError;

  const jobs = readable
    .filter((row) => row.epub_source_url)
    .map((row) => ({ book_id: row.id, source_url: row.epub_source_url, status: "pending" }));
  if (jobs.length) {
    const { error: queueError } = await db.from("epub_ingest_jobs").upsert(jobs, {
      onConflict: "book_id",
      ignoreDuplicates: true,
    });
    if (queueError) throw queueError;
  }

  const update = {
    next_page: json.next ? pageFromUrl(json.next) : page + 1,
    next_url: json.next,
    last_run_at: new Date().toISOString(),
    last_inserted: readable.length,
    total_catalog_count: json.count,
    completed_at: json.next ? null : new Date().toISOString(),
    cycle_started_at: page === 1 ? new Date().toISOString() : state?.cycle_started_at,
    failure_count: 0,
  };
  const { error: updateError } = await db.from("ingest_state").update(update).eq("id", 1);
  if (updateError) throw updateError;

  return {
    page,
    sourceUrl,
    fetched: json.results.length,
    inserted: readable.length,
    queuedEpubs: jobs.length,
    nextUrl: json.next,
    complete: json.next === null,
  };
}

export async function runEpubWorker(limit = 3): Promise<EpubWorkerResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;
  const safeLimit = Math.max(1, Math.min(10, limit));
  const { data: jobs, error } = await db
    .from("epub_ingest_jobs")
    .select("book_id,source_url,attempts")
    .in("status", ["pending", "retry"])
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(safeLimit);
  if (error) throw error;

  let downloaded = 0;
  let failed = 0;
  for (const job of jobs ?? []) {
    await db
      .from("epub_ingest_jobs")
      .update({ status: "downloading", started_at: new Date().toISOString() })
      .eq("book_id", job.book_id);
    try {
      const response = await fetch(job.source_url, {
        headers: {
          Accept: "application/epub+zip, application/zip;q=0.9, */*;q=0.1",
          "User-Agent": "CoveReader/1.0",
        },
      });
      if (!response.ok) throw new Error(`EPUB source ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
        throw new Error("Downloaded file is not a valid EPUB/ZIP archive");
      if (bytes.byteLength > 100 * 1024 * 1024)
        throw new Error("EPUB exceeds the 100 MB safety limit");

      const path = `${job.book_id}.epub`;
      const { error: uploadError } = await supabaseAdmin.storage.from("epubs").upload(path, bytes, {
        contentType: "application/epub+zip",
        cacheControl: "31536000",
        upsert: true,
      });
      if (uploadError) throw uploadError;
      const { data: publicUrl } = supabaseAdmin.storage.from("epubs").getPublicUrl(path);
      const completedAt = new Date().toISOString();
      await db
        .from("books")
        .update({
          epub_storage_path: path,
          epub_url: publicUrl.publicUrl,
          epub_cached_at: completedAt,
        })
        .eq("id", job.book_id);
      await db
        .from("epub_ingest_jobs")
        .update({ status: "completed", completed_at: completedAt, last_error: null })
        .eq("book_id", job.book_id);
      downloaded += 1;
    } catch (caught) {
      const attempts = Number(job.attempts ?? 0) + 1;
      const retryMinutes = Math.min(24 * 60, 2 ** attempts * 5);
      await db
        .from("epub_ingest_jobs")
        .update({
          status: attempts >= 8 ? "failed" : "retry",
          attempts,
          last_error:
            caught instanceof Error ? caught.message.slice(0, 1000) : String(caught).slice(0, 1000),
          next_attempt_at: new Date(Date.now() + retryMinutes * 60_000).toISOString(),
        })
        .eq("book_id", job.book_id);
      failed += 1;
    }
  }

  return { attempted: (jobs ?? []).length, downloaded, failed };
}
