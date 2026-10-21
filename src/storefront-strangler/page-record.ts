import { ApiError } from "../features/fore/service";
function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function normalizePath(value: string) {
  let path = value.trim();
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/[/]{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

export function formatGenericStorefrontPageRecord(
  pathValue: string,
  record: Record<string, unknown> | null,
) {
  const path = normalizePath(pathValue);
  const row = record;
  if (!row) {
    if (["/", "/store", "/search"].includes(path)) {
      return {
        path,
        pageType: path === "/search" ? "search" : "home",
        title: "Bookstore",
        heading: path === "/search" ? "Search the bookstore" : "Find your next great read.",
        eyebrow: "THE BOOKSTORE",
        description: "Stories to get lost in. Ideas to carry with you.",
        seoTitle: path === "/search" ? "Search eBooks | Cove" : "Cove — Bookstore & Reading Room",
        seoDescription: "Discover ebooks, read online, and build your reading life.",
        noindex: path === "/search",
        canonical: path === "/store" ? "/" : path,
        query: {},
      };
    }
    throw new ApiError(404, "This bookstore page does not exist.");
  }
  return {
    path: String(row.path),
    pageType: String(row.page_type),
    title: String(row.title),
    heading: String(row.heading),
    eyebrow: String(row.eyebrow || "THE BOOKSTORE"),
    description: String(row.description || ""),
    seoTitle: String(row.seo_title || row.title),
    seoDescription: String(row.seo_description || row.description || ""),
    noindex: !!row.noindex,
    canonical: String(row.path),
    query: parseObject(row.query_json),
  };
}
