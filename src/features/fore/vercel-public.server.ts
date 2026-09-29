import seed from "./catalog-seed.json";
import audioSeed from "./audio-seed.json";
import { mirrorUrl } from "./gutenberg-source";

type Env = {
  DB?: unknown;
  GUTENDEX_BASE_URL?: string;
  GUTENBERG_MIRROR_BASE_URL?: string;
};

const pageCache = new Map<string, { at: number; value: any }>();
const audioCache = new Map<string, { at: number; value: any }>();

function j(data: unknown, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
      "X-Cove-Runtime": "vercel-public-domain",
    },
  });
}

function base(env: Env) {
  const raw = (env.GUTENDEX_BASE_URL || "https://gutendex.com").replace(/\/+$/, "");
  return raw.endsWith("/books") ? raw.slice(0, -6) : raw;
}

async function getJson(url: string, timeout = 12000) {
  const cached = pageCache.get(url);
  if (cached && Date.now() - cached.at < 300000) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Cove/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Upstream returned " + response.status);
    const value = await response.json();
    pageCache.set(url, { at: Date.now(), value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

function book(raw: any) {
  return {
    id: raw.id,
    sourceExternalId: String(raw.id),
    sourceName: "gutenberg",
    sourceProject: "Project Gutenberg",
    sourceUrl: "https://www.gutenberg.org/ebooks/" + raw.id,
    sourceLicenseUrl: "https://www.gutenberg.org/policy/license.html",
    title: raw.title || "Project Gutenberg #" + raw.id,
    authors: (raw.authors || []).map((x: any) => ({ name: x.name })),
    summaries: raw.summaries || [],
    subjects: raw.subjects || [],
    bookshelves: raw.bookshelves || [],
    languages: raw.languages || [],
    formats: raw.formats || {},
    download_count: Number(raw.download_count || 0),
    copyright: raw.copyright === false ? false : raw.copyright ?? undefined,
    drmStatus: "none",
    downloadable: true,
    releaseStatus: "released",
    offer: { type: "free", currency: "USD", amountMinor: 0 },
  };
}

function seedCatalog(url: URL) {
  const terms = (url.searchParams.get("search") || "").toLowerCase().split(/\s+/).filter(Boolean);
  const topic = (url.searchParams.get("taxonomy") || "").split("/").filter(Boolean).pop()?.replace(/[-_]/g, " ").toLowerCase() || "";
  const language = url.searchParams.get("language") || "";
  let rows = (seed.results as any[]).filter((x) => {
    const text = [x.title, ...(x.authors || []).map((a: any) => a.name), ...(x.subjects || []), ...(x.bookshelves || [])].join(" ").toLowerCase();
    return terms.every((term) => text.includes(term)) && (!topic || text.includes(topic)) && (!language || (x.languages || []).includes(language));
  }).map(book);
  if ((url.searchParams.get("sort") || "") === "title") rows.sort((a, b) => a.title.localeCompare(b.title));
  if (Number(url.searchParams.get("page") || 1) > 1) rows = [];
  return rows;
}

function facets(rows: any[], count: number) {
  const languages = new Map<string, number>();
  for (const row of rows) for (const language of row.languages || []) languages.set(language, (languages.get(language) || 0) + 1);
  return {
    categories: [],
    languages: [...languages].map(([value, n]) => ({ value, count: n })),
    formats: [{ value: "EPUB", count }],
    publishers: [],
    series: [],
    availability: [{ value: "free", count }],
    price: { currency: "USD", min: 0, max: 0 },
  };
}

async function catalog(env: Env, requestUrl: URL) {
  const upstream = new URL(base(env) + "/books/");
  upstream.searchParams.set("copyright", "false");
  upstream.searchParams.set("mime_type", "application/epub+zip");
  const search = (requestUrl.searchParams.get("search") || "").trim();
  const language = requestUrl.searchParams.get("language") || "";
  const taxonomy = requestUrl.searchParams.get("taxonomy") || "";
  const page = Math.max(1, Number(requestUrl.searchParams.get("page") || 1) || 1);
  const sort = requestUrl.searchParams.get("sort") || "";
  if (search) upstream.searchParams.set("search", search.slice(0, 160));
  if (/^[a-z]{2}$/i.test(language)) upstream.searchParams.set("languages", language.toLowerCase());
  if (taxonomy) {
    const topic = taxonomy.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ");
    if (topic) upstream.searchParams.set("topic", topic);
  }
  upstream.searchParams.set("page", String(page));
  upstream.searchParams.set("sort", ["released", "published", "added", "updated", "new"].includes(sort) ? "descending" : "popular");
  try {
    const data: any = await getJson(upstream.toString());
    let rows = (data.results || []).filter((x: any) => x.copyright === false).map(book);
    if (sort === "title") rows.sort((a: any, b: any) => a.title.localeCompare(b.title));
    return {
      results: rows,
      count: Number(data.count || rows.length),
      next: data.next ? "next" : null,
      cached: false,
      facets: facets(rows, Number(data.count || rows.length)),
      search: { queryId: null, backend: "gutendex-live", processingTimeMs: 0, correctedQuery: null, pageSize: 32 },
      ingestion: { status: "live", cachedBooks: rows.length, totalCatalogCount: Number(data.count || rows.length), mode: "vercel-stateless" },
    };
  } catch (error) {
    console.warn("Gutendex catalog fallback", error instanceof Error ? error.message : String(error));
    const rows = seedCatalog(requestUrl);
    return {
      results: rows,
      count: rows.length,
      next: null,
      cached: true,
      warning: "The live Gutenberg index is reconnecting. Cove is showing its bundled public-domain collection meanwhile.",
      facets: facets(rows, rows.length),
      search: { queryId: null, backend: "bundled-seed", processingTimeMs: 0, correctedQuery: null, pageSize: 24 },
      ingestion: { status: "fallback", cachedBooks: rows.length, totalCatalogCount: rows.length, mode: "vercel-stateless" },
    };
  }
}

async function oneBook(env: Env, id: string) {
  if (!/^[1-9][0-9]{0,8}$/.test(id)) throw new Error("Invalid Gutenberg id.");
  try {
    const raw: any = await getJson(base(env) + "/books/" + id, 10000);
    if (raw.copyright !== false) throw new Error("This edition is not confirmed public domain in the USA.");
    return book(raw);
  } catch (error) {
    const local = (seed.results as any[]).find((x) => String(x.id) === id);
    if (local) return book(local);
    throw error;
  }
}

function epubUrl(row: any) {
  return row.formats?.["application/epub+zip"] || Object.entries(row.formats || {}).find(([type]) => type.startsWith("application/epub"))?.[1] || "";
}

async function serveEpub(env: Env, id: string, attachment: boolean) {
  const row = await oneBook(env, id);
  const source = epubUrl(row);
  if (!source) return j({ error: "This Gutenberg edition has no EPUB file." }, 404);
  let target = source;
  try { target = mirrorUrl(source, env.GUTENBERG_MIRROR_BASE_URL); } catch {}
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(target, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) return j({ error: "The Gutenberg EPUB mirror is temporarily unavailable." }, 502);
    const headers = new Headers({
      "Content-Type": "application/epub+zip",
      "Content-Disposition": (attachment ? "attachment" : "inline") + '; filename="cove-gutenberg-' + id + '.epub"',
      "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
      "X-Cove-Runtime": "vercel-public-domain",
    });
    const length = response.headers.get("content-length");
    if (length) headers.set("Content-Length", length);
    return new Response(response.body, { headers });
  } finally {
    clearTimeout(timer);
  }
}

function detail(row: any) {
  const id = String(row.id);
  return {
    book: row,
    commerce: {
      territory: "US",
      offer: { id: "free-pg-" + id, type: "free", currency: "USD", amountMinor: 0, listAmountMinor: 0 },
      available: true, entitled: true, canReadFull: true, publicDomain: true, source: "gutenberg", preorder: null,
    },
    ratings: { average: 0, count: 0, distribution: {} },
    rankings: [], taxonomy: [],
    preview: { available: false, policy: null },
    wishlist: { saved: false, alerts: null },
    distribution: { drmStatus: "none", downloadable: true, fileSizeBytes: null, epubVersion: null, assetVersion: null },
    contentDisclosure: null,
    editions: [{ editionId: "pg-" + id, externalBookId: id, productId: "pg-" + id, language: row.languages?.[0] || "en", editionNumber: "Project Gutenberg", publicationDate: null, releaseDate: null, format: "ebook", publisher: "Project Gutenberg", imprint: "", offer: { type: "free", currency: "USD", amountMinor: 0 }, current: true }],
  };
}

function narration(raw: any) {
  const text = [...(raw.bookshelves || []), ...(raw.subjects || [])].join(" ").toLowerCase();
  if (/human[- ]read/.test(text)) return "human";
  if (/computer[- ]generated|computer[- ]read|synthetic/.test(text)) return "computer";
  return "unknown";
}

function audioItem(raw: any) {
  return {
    id: "pg-" + raw.id,
    gutenbergId: String(raw.id),
    bookId: null,
    title: raw.title || "Project Gutenberg recording #" + raw.id,
    authors: (raw.authors || []).map((x: any) => ({ name: x.name })),
    language: raw.languages?.[0] || "und",
    narration: narration(raw),
    narrator: "",
    sourceUrl: "https://www.gutenberg.org/ebooks/" + raw.id,
    rights: "Public domain in the USA.",
    tracks: [],
    alignment: null,
    epubSha256: null,
  };
}

async function audiobooks(env: Env, url: URL) {
  const linkedId = (url.searchParams.get("bookId") || "").trim();
  if (linkedId) {
    const linked = (audioSeed as any[]).filter((x) => x.bookId === linkedId);
    return { results: linked, count: linked.length, page: 1, pages: 1, source: "bundled-link-map" };
  }
  const upstream = new URL(base(env) + "/books/");
  upstream.searchParams.set("copyright", "false");
  upstream.searchParams.set("mime_type", "audio/");
  const q = (url.searchParams.get("search") || "").trim();
  const kind = url.searchParams.get("narration") || "all";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  if (q) upstream.searchParams.set("search", q.slice(0, 160));
  upstream.searchParams.set("topic", kind === "human" ? "Audio Book, human-read" : kind === "computer" ? "Audio Book, computer-generated" : "Audio Book");
  upstream.searchParams.set("page", String(page));
  upstream.searchParams.set("sort", url.searchParams.get("sort") === "new" ? "descending" : "popular");
  try {
    const data: any = await getJson(upstream.toString());
    let rows = (data.results || []).filter((x: any) => x.copyright === false && x.media_type === "Sound").map(audioItem);
    if (kind !== "all") rows = rows.filter((x: any) => x.narration === kind);
    if ((url.searchParams.get("sort") || "title") === "title") rows.sort((a: any, b: any) => a.title.localeCompare(b.title));
    const count = Number(data.count || rows.length);
    return { results: rows, count, page, pages: Math.max(1, Math.ceil(count / 32)), source: "gutendex-live" };
  } catch (error) {
    console.warn("Gutendex audio fallback", error instanceof Error ? error.message : String(error));
    const rows = (audioSeed as any[]).filter((x) => kind === "all" || x.narration === kind);
    return { results: page === 1 ? rows : [], count: rows.length, page, pages: 1, source: "bundled-seed", warning: "The live Gutenberg audio index is reconnecting. Cove is showing its bundled verified recording meanwhile." };
  }
}

function decodeXml(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function tracks(env: Env, id: string) {
  const source = "https://www.gutenberg.org/cache/epub/" + id + "/pg" + id + ".rdf";
  let target = source;
  try { target = mirrorUrl(source, env.GUTENBERG_MIRROR_BASE_URL); } catch {}
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(target, { signal: controller.signal });
    if (!response.ok) throw new Error("RDF metadata returned " + response.status);
    const rdf = await response.text();
    const urls = [...rdf.matchAll(/rdf:about=["']([^"']+\.(?:mp3|m4b|ogg))(?:\?[^"']*)?["']/gi)]
      .map((m) => decodeXml(m[1]))
      .filter((value, index, values) => values.indexOf(value) === index)
      .filter((value) => {
        try {
          const u = new URL(value);
          return u.protocol === "https:" && ["www.gutenberg.org", "gutenberg.org"].includes(u.hostname) && u.pathname.split("/").includes(id);
        } catch { return false; }
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    return urls.map((url, index) => {
      const ext = new URL(url).pathname.toLowerCase().split(".").pop();
      return { id: String(index + 1).padStart(2, "0"), title: "Track " + (index + 1), url, mime: ext === "m4b" ? "audio/mp4" : ext === "ogg" ? "audio/ogg" : "audio/mpeg" };
    });
  } finally {
    clearTimeout(timer);
  }
}

async function audioEdition(env: Env, ref: string) {
  const cached = audioCache.get(ref);
  if (cached && Date.now() - cached.at < 1800000) return cached.value;
  const local = (audioSeed as any[]).find((x) => x.id === ref || x.gutenbergId === ref.replace(/^pg-/, ""));
  if (local) return local;
  const id = ref.replace(/^pg-/, "");
  if (!/^[1-9][0-9]{0,8}$/.test(id)) throw new Error("Invalid audiobook id.");
  const raw: any = await getJson(base(env) + "/books/" + id, 10000);
  if (raw.copyright !== false || raw.media_type !== "Sound") throw new Error("This public-domain recording is unavailable.");
  const media = await tracks(env, id);
  if (!media.length) throw new Error("Project Gutenberg did not publish playable track metadata for this recording.");
  const value = { ...audioItem(raw), tracks: media };
  audioCache.set(ref, { at: Date.now(), value });
  return value;
}

async function audioTrack(env: Env, ref: string, trackId: string, request: Request) {
  const edition = await audioEdition(env, ref);
  const track = edition.tracks.find((x: any) => x.id === trackId);
  if (!track) return j({ error: "This audio track was not found." }, 404);
  let target: string;
  try { target = mirrorUrl(track.url, env.GUTENBERG_MIRROR_BASE_URL); }
  catch { return j({ error: "This audio source is not trusted." }, 502); }
  const headers: Record<string, string> = {};
  const range = request.headers.get("range");
  if (range && /^bytes=(\d*)-(\d*)$/.test(range)) headers.Range = range;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const upstream = await fetch(target, { method: request.method, headers, redirect: "follow", signal: controller.signal });
    if (![200, 206, 416].includes(upstream.status)) return j({ error: "The audio mirror could not provide this track." }, 502);
    const out = new Headers({
      "Content-Type": track.mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
      "X-Cove-Runtime": "vercel-public-domain",
    });
    for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: out });
  } finally {
    clearTimeout(timer);
  }
}

function storefront() {
  return {
    storefrontCountry: "US", rightsCountry: "US", locale: "en-US", language: "en", currency: "USD", direction: "ltr",
    taxInclusive: false, checkoutEnabled: false, paymentMethods: [], messages: {}, runtimeMode: "vercel-public-domain",
    availableMarkets: [{ countryCode: "US", displayName: "United States", defaultLocale: "en-US", defaultCurrency: "USD", taxInclusive: false, checkoutEnabled: false, locales: ["en-US"] }],
  };
}

const taxonomy = ["Fiction", "Classics", "Romance", "Mystery", "Science Fiction", "Fantasy", "History", "Philosophy", "Children"].map((name, index) => {
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  return { id: "vercel-" + slug, slug, path: slug, depth: 0, name, description: "Public-domain " + name.toLowerCase() + " from Project Gutenberg.", count: 1, featured: index < 6, href: "/ebooks/" + slug, children: [] };
});

export async function handleVercelPublicRequest(request: Request, env: Env, path: string): Promise<Response | null> {
  if (env.DB) return null;
  const method = request.method, url = new URL(request.url);
  if (method === "GET" && path === "/account") return j({ user: null, library: [], annotations: [], bookmarks: [], definitions: [] });
  if (method === "GET" && path === "/storefront/context") return j(storefront(), 200, "public, s-maxage=300, stale-while-revalidate=3600");
  if (method === "POST" && path === "/storefront/context") return j({ saved: true, runtimeMode: "vercel-public-domain" });
  if (method === "GET" && path === "/taxonomy") return j({ taxonomy: "vercel-public-domain", version: "1", featured: taxonomy.filter((x) => x.featured), nodes: taxonomy }, 200, "public, s-maxage=3600");
  if (method === "GET" && path === "/storefront/page") {
    const p = url.searchParams.get("path") || "/store";
    return j({ path: p, pageType: p === "/" || p === "/store" ? "home" : "catalog", title: "Cove", heading: p === "/" || p === "/store" ? "Bookstore" : undefined, canonical: p, query: {}, statusCode: 200 });
  }
  if (method === "GET" && path === "/merchandising") return j({ visitorId: url.searchParams.get("visitor") || "", slots: {} });
  if (method === "GET" && path === "/recommendations/home") return j({ rails: [], personalization: { enabled: false, activityLearning: false, personalizedSearch: false }, model: { key: "vercel-public-domain", version: "1", externalScorer: false } });
  if (method === "POST" && ["/events", "/merchandising/event", "/recommendations/event"].includes(path)) return j({ recorded: false, stateless: true });
  if (method === "GET" && path === "/checkout/config") return j({ configured: false, publishableKey: "", storefront: storefront() });
  if (method === "GET" && path === "/catalog") return j(await catalog(env, url), 200, "public, s-maxage=300, stale-while-revalidate=1800");
  if (method === "GET" && path === "/search/suggest") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2) return j({ suggestions: [] });
    try {
      const u = new URL(base(env) + "/books/");
      u.searchParams.set("copyright", "false"); u.searchParams.set("mime_type", "application/epub+zip"); u.searchParams.set("search", q.slice(0, 100));
      const data: any = await getJson(u.toString());
      return j({ suggestions: (data.results || []).slice(0, 8).map((x: any) => ({ type: "book", productId: String(x.id), bookId: String(x.id), label: x.title, sublabel: (x.authors || []).map((a: any) => a.name).join(", ") || "Project Gutenberg" })) });
    } catch { return j({ suggestions: [] }); }
  }
  const reviews = path.match(/^\/books\/([1-9][0-9]{0,8})\/reviews$/);
  if (method === "GET" && reviews) return j({ reviews: [], mine: null, count: 0, page: 1, pages: 1, summary: { count: 0, average: null, distribution: [] } });
  const bm = path.match(/^\/books\/([1-9][0-9]{0,8})(?:\/(detail|epub|download\/epub))?$/);
  if (bm && ["GET", "HEAD"].includes(method)) {
    try {
      if (bm[2] === "epub") return serveEpub(env, bm[1], false);
      if (bm[2] === "download/epub") return serveEpub(env, bm[1], true);
      const row = await oneBook(env, bm[1]);
      return j(bm[2] === "detail" ? detail(row) : row, 200, "public, s-maxage=1800, stale-while-revalidate=86400");
    } catch (error) { return j({ error: error instanceof Error ? error.message : "This Gutenberg edition is unavailable." }, 404); }
  }
  if (method === "GET" && path === "/audiobooks") return j(await audiobooks(env, url), 200, "public, s-maxage=300, stale-while-revalidate=1800");
  const tm = path.match(/^\/audio\/([^/]+)\/tracks\/([^/]+)$/);
  if (tm && ["GET", "HEAD"].includes(method)) return audioTrack(env, decodeURIComponent(tm[1]), decodeURIComponent(tm[2]), request);
  const am = path.match(/^\/audio\/([^/]+)$/);
  if (am && method === "GET") {
    try { return j(await audioEdition(env, decodeURIComponent(am[1])), 200, "public, s-maxage=1800, stale-while-revalidate=86400"); }
    catch (error) { return j({ error: error instanceof Error ? error.message : "This public-domain recording is unavailable." }, 404); }
  }
  return null;
}
