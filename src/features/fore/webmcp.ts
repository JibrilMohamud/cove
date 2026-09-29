import { api } from "./client";
export function registerReadingTools(reload: () => Promise<void>) {
  const context = (document as any).modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const tools = [
    {
      name: "search_fore_catalog",
      title: "Search the bookstore",
      description: "Find free EPUB books by title, author, subject, and language.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", maxLength: 160 },
          topic: { type: "string", maxLength: 160 },
          language: { type: "string", maxLength: 10 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input: unknown) {
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw Error("Provide a search object.");
        const v = input as Record<string, unknown>;
        if (
          Object.entries(v).some(
            ([k, x]) =>
              !["search", "topic", "language"].includes(k) ||
              typeof x !== "string" ||
              x.length > 160,
          )
        )
          throw Error("Invalid search field.");
        const p = new URLSearchParams({
          search: String(v.search || ""),
          topic: String(v.topic || ""),
          languages: String(v.language || ""),
          page: "1",
        });
        const d = await api("/catalog?" + p);
        return {
          count: d.count,
          books: d.results.map((b: any) => ({
            id: String(b.id),
            title: b.title,
            authors: b.authors,
            languages: b.languages,
          })),
          warning: d.warning || null,
        };
      },
    },
    {
      name: "add_fore_books_to_library",
      title: "Add books to my library",
      description:
        "Save one or more catalog books to the signed-in reader’s library. Requires an authenticated account.",
      inputSchema: {
        type: "object",
        properties: {
          bookIds: {
            type: "array",
            items: { type: "string", pattern: "^(?:[1-9][0-9]{0,8}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,100})$" },
            minItems: 1,
            maxItems: 10,
          },
        },
        required: ["bookIds"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input: unknown) {
        const v = input as any;
        if (
          !v ||
          !Array.isArray(v.bookIds) ||
          v.bookIds.length < 1 ||
          v.bookIds.length > 10 ||
          Object.keys(v).some((k) => k !== "bookIds") ||
          v.bookIds.some((id: any) => typeof id !== "string" || !/^(?:[1-9][0-9]{0,8}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,100})$/.test(id))
        )
          throw Error("Provide 1–10 valid book IDs.");
        const saved = [];
        for (const id of new Set<string>(v.bookIds)) {
          await api("/library", "POST", { bookId: id });
          saved.push(id);
        }
        await reload();
        return { saved };
      },
    },
  ];
  for (const tool of tools)
    try {
      Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});
    } catch {}
  return () => lifecycle.abort();
}
