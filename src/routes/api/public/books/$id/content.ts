import { createFileRoute } from "@tanstack/react-router";

type SourceBook = { text_url: string | null; html_url: string | null; title?: string | null };
type GutendexBook = { formats?: Record<string, string>; title?: string };

function cleanGutenbergText(raw: string) {
  const startMatch = raw.match(
    /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i,
  );
  const endMatch = raw.match(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i);
  let body = raw;
  if (startMatch && startMatch.index !== undefined) {
    body = body.slice(startMatch.index + startMatch[0].length);
  }
  if (endMatch && endMatch.index !== undefined) {
    const cut = body.indexOf(endMatch[0]);
    if (cut >= 0) body = body.slice(0, cut);
  }
  return body.trim();
}

function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatUrl(formats: Record<string, string> | undefined, prefix: string) {
  if (!formats) return null;
  const entry = Object.entries(formats).find(
    ([key, value]) => key.startsWith(prefix) && !value.endsWith(".zip"),
  );
  return entry?.[1] ?? null;
}

async function findBook(id: number): Promise<SourceBook | null> {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data } = await supabaseAdmin
        .from("books")
        .select("text_url, html_url, title")
        .eq("id", id)
        .single();
      if (data?.text_url || data?.html_url) return data;
    } catch (error) {
      console.warn("Falling back to Gutendex for book content:", error);
    }
  }

  const response = await fetch(`https://gutendex.com/books/${id}/`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const book = (await response.json()) as GutendexBook;
  return {
    text_url: formatUrl(book.formats, "text/plain"),
    html_url: formatUrl(book.formats, "text/html"),
    title: book.title ?? null,
  };
}

export const Route = createFileRoute("/api/public/books/$id/content")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const book = await findBook(Number(params.id));
          if (!book?.text_url && !book?.html_url) {
            return new Response("This edition does not include readable text.", { status: 404 });
          }

          const source = book.text_url ?? book.html_url!;
          const upstream = await fetch(source);
          if (!upstream.ok)
            return new Response("The book source is temporarily unavailable.", { status: 502 });
          const raw = await upstream.text();
          const text = book.text_url
            ? cleanGutenbergText(raw)
            : cleanGutenbergText(htmlToText(raw));

          return new Response(text, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
            },
          });
        } catch (error) {
          console.warn("Public book content could not be fetched:", error);
          return new Response("The public book source is temporarily unavailable.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      },
    },
  },
});
