import { getSupabaseClient } from "@/integrations/supabase/client";

export type Book = {
  id: number;
  title: string;
  authors: { name: string; birth_year: number | null; death_year: number | null }[];
  translators: { name: string }[];
  summary: string | null;
  categories: string[];
  languages: string[];
  cover_url: string | null;
  epub_url: string | null;
  html_url: string | null;
  text_url: string | null;
  download_count: number;
};

type GutendexPerson = {
  name: string;
  birth_year?: number | null;
  death_year?: number | null;
};

type GutendexBook = {
  id: number;
  title: string;
  authors?: GutendexPerson[];
  translators?: GutendexPerson[];
  summaries?: string[];
  subjects?: string[];
  bookshelves?: string[];
  languages?: string[];
  formats?: Record<string, string>;
  download_count?: number;
};

type GutendexPage = { results?: GutendexBook[]; next?: string | null };

const GUTENDEX = "https://gutendex.com";

function firstFormat(formats: Record<string, string> | undefined, matches: string[]) {
  if (!formats) return null;
  for (const exact of matches) {
    if (formats[exact]) return formats[exact];
  }
  const entry = Object.entries(formats).find(
    ([key, value]) => matches.some((match) => key.startsWith(match)) && !value.endsWith(".zip"),
  );
  return entry?.[1] ?? null;
}

function fromGutendex(book: GutendexBook): Book {
  const formats = book.formats ?? {};
  return {
    id: book.id,
    title: book.title,
    authors: (book.authors ?? []).map((person) => ({
      name: person.name,
      birth_year: person.birth_year ?? null,
      death_year: person.death_year ?? null,
    })),
    translators: (book.translators ?? []).map((person) => ({ name: person.name })),
    summary: book.summaries?.[0] ?? null,
    categories: Array.from(new Set([...(book.subjects ?? []), ...(book.bookshelves ?? [])])).slice(
      0,
      14,
    ),
    languages: book.languages ?? [],
    cover_url: firstFormat(formats, ["image/jpeg", "image/png"]),
    epub_url: firstFormat(formats, ["application/epub+zip"]),
    html_url: firstFormat(formats, ["text/html; charset=utf-8", "text/html"]),
    text_url: firstFormat(formats, ["text/plain; charset=utf-8", "text/plain"]),
    download_count: book.download_count ?? 0,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
  return (await response.json()) as T;
}

async function gutendexBooks(opts: { limit: number; category?: string; search?: string }) {
  const books: Book[] = [];
  const url = new URL(`${GUTENDEX}/books/`);
  if (opts.category) url.searchParams.set("topic", opts.category);
  if (opts.search) url.searchParams.set("search", opts.search);
  url.searchParams.set("copyright", "false");

  let next: string | null = url.toString();
  while (next && books.length < opts.limit) {
    const page: GutendexPage = await fetchJson<GutendexPage>(next);
    books.push(...(page.results ?? []).map(fromGutendex));
    next = page.next ?? null;
  }
  return books.slice(0, opts.limit);
}

export async function fetchBooks(
  opts: { limit?: number; orderBy?: "download_count" | "created_at"; category?: string } = {},
) {
  const { limit = 30, orderBy = "download_count", category } = opts;
  const client = getSupabaseClient();
  if (client) {
    try {
      let query = client
        .from("books")
        .select("*")
        .order(orderBy, { ascending: false })
        .limit(limit);
      if (category) query = query.contains("categories", [category]);
      const { data, error } = await query;
      if (!error && data?.length) return data as unknown as Book[];
    } catch (error) {
      console.warn("Using Gutendex because the synced catalog is unavailable:", error);
    }
  }
  return gutendexBooks({ limit, category });
}

export async function fetchBook(id: number) {
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from("books").select("*").eq("id", id).single();
      if (!error && data) return data as unknown as Book;
    } catch (error) {
      console.warn(
        "Using Gutendex for this book because the synced catalog is unavailable:",
        error,
      );
    }
  }
  return fromGutendex(await fetchJson<GutendexBook>(`${GUTENDEX}/books/${id}/`));
}

export async function searchBooks(query: string) {
  const clean = query
    .trim()
    .replace(/[,%()]/g, " ")
    .replace(/\s+/g, " ");
  if (!clean) return [];

  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client
        .from("books")
        .select("*")
        .or(`title.ilike.%${clean}%,summary.ilike.%${clean}%`)
        .order("download_count", { ascending: false })
        .limit(40);
      if (!error && data) return data as unknown as Book[];
    } catch (error) {
      console.warn("Using Gutendex search because the synced catalog is unavailable:", error);
    }
  }
  return gutendexBooks({ limit: 40, search: clean });
}

export async function fetchCategories() {
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from("books").select("categories").limit(500);
      if (!error && data) {
        const counts = new Map<string, number>();
        for (const row of data) {
          for (const category of (row as { categories: string[] }).categories ?? []) {
            counts.set(category, (counts.get(category) ?? 0) + 1);
          }
        }
        if (counts.size) {
          return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => ({ name, count }));
        }
      }
    } catch (error) {
      console.warn("Using local category suggestions:", error);
    }
  }

  return [
    "Fiction",
    "Adventure stories",
    "Fantasy fiction",
    "Science fiction",
    "Mystery and detective stories",
    "Romance fiction",
    "Historical fiction",
    "Poetry",
    "Drama",
    "Philosophy",
    "History",
    "Biography",
  ].map((name, index) => ({ name, count: 12 - index }));
}

export type BookReview = {
  user_id: string;
  book_id: number;
  rating: number | null;
  review: string;
  updated_at: string;
  profiles?: { display_name: string | null } | null;
};

export async function fetchBookReviews(bookId: number): Promise<BookReview[]> {
  const client = getSupabaseClient();
  if (!client) return [];
  try {
    // The generated Database type is refreshed after the reader migration is applied.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;
    const { data, error } = await db
      .from("book_reviews")
      .select("user_id,book_id,rating,review,updated_at,profiles(display_name)")
      .eq("book_id", bookId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(30);
    if (error) return [];
    return (data ?? []) as BookReview[];
  } catch {
    return [];
  }
}
