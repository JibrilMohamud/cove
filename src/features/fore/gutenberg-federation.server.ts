import JSZip from "jszip";

export type RegionalSourceId = "pg_ca" | "pg_au" | "pg_eu";
export type RegionalCatalogItem = {
  sourceId: RegionalSourceId;
  sourceItemId: string;
  externalId: string;
  title: string;
  authors: { name: string }[];
  languages: string[];
  subjects: string[];
  bookshelves: string[];
  formats: Record<string, string>;
  sourceUrl: string;
  evidenceUrl: string;
  territories: string[];
  metadata?: Record<string, unknown>;
};

export type FederationEnv = {
  FORE_GUTENBERG_CANADA_CATALOG_URL?: string;
  FORE_GUTENBERG_AUSTRALIA_CATALOG_URL?: string;
  FORE_GUTENBERG_EUROPE_FEED_URL?: string;
  FORE_GUTENBERG_EUROPE_TRUSTED_ORIGINS?: string;
};

const SOURCE_CONFIG = {
  pg_ca: {
    catalog: "https://www.gutenberg.ca/index.html",
    homepage: "https://www.gutenberg.ca/",
    license: "https://www.gutenberg.ca/links/licence.html",
    territory: "CA",
  },
  pg_au: {
    catalog: "https://www.gutenberg.net.au/plusfifty.html",
    catalogShards: [
      "https://www.gutenberg.net.au/plusfifty-a-m.html",
      "https://www.gutenberg.net.au/plusfifty-n-z.html",
    ],
    homepage: "https://www.gutenberg.net.au/",
    license: "https://gutenberg.net.au/licence.html",
    territory: "AU",
  },
  pg_eu: {
    catalog: "https://rastko.net/showrss.php?id=ge",
    homepage: "https://rastko.net/showrss.php?id=ge",
    license: "https://www.gutenberg.org/help/faq.html",
    territory: "",
  },
} as const;

export function regionalSourceConfig(sourceId: RegionalSourceId, env: FederationEnv = {}) {
  if (sourceId === "pg_ca") return { ...SOURCE_CONFIG.pg_ca, catalog: env.FORE_GUTENBERG_CANADA_CATALOG_URL || SOURCE_CONFIG.pg_ca.catalog };
  if (sourceId === "pg_au") {
    const override = env.FORE_GUTENBERG_AUSTRALIA_CATALOG_URL?.trim();
    return { ...SOURCE_CONFIG.pg_au, catalog: override || SOURCE_CONFIG.pg_au.catalog, catalogShards: override ? [override] : [...SOURCE_CONFIG.pg_au.catalogShards] };
  }
  return { ...SOURCE_CONFIG.pg_eu, catalog: env.FORE_GUTENBERG_EUROPE_FEED_URL || "" };
}

function cleanText(value: string) {
  return decodeEntities(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}
function decodeEntities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}
function stableFingerprint(value: string) {
  // FNV-1a is used only as a deterministic change/collision fingerprint; legal evidence itself is
  // separately SHA-256 hashed when it is approved.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0");
}
function safeId(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) throw new Error("Source item has no stable identifier.");
  return normalized.length <= 90 ? normalized : `${normalized.slice(0, 80)}_${stableFingerprint(normalized)}`;
}
export function federatedExternalId(sourceId: RegionalSourceId, sourceItemId: string) {
  const prefix = sourceId === "pg_ca" ? "pgca" : sourceId === "pg_au" ? "pgau" : "pgeu";
  return `${prefix}_${safeId(sourceItemId)}`;
}
function absoluteUrl(href: string, base: string) {
  try { return new URL(decodeEntities(href), base).href; } catch { return ""; }
}
function htmlAttr(tag: string, name: string) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return m?.[1] || "";
}
function titleFromChunk(chunk: string, epubHref: string) {
  const links = [...chunk.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: m[1], text: cleanText(m[2]) }))
    .filter((x) => x.text && !/^(epub|mobi|kindle|html|text|txt|pdf|download|zip)$/i.test(x.text));
  const exact = links.find((x) => x.href !== epubHref && x.text.length > 2);
  if (exact) return exact.text;
  const italic = [...chunk.matchAll(/<(?:i|em|strong|b)[^>]*>([\s\S]*?)<\/(?:i|em|strong|b)>/gi)]
    .map((m) => cleanText(m[1])).find((x) => x.length > 2 && !/^epub$/i.test(x));
  return italic || "";
}
function authorBefore(html: string, offset: number) {
  const prefix = html.slice(Math.max(0, offset - 12000), offset);
  const headers = [...prefix.matchAll(/<(?:h2|h3|h4|b|strong)[^>]*>([\s\S]*?)<\/(?:h2|h3|h4|b|strong)>/gi)];
  const candidate = headers.length ? cleanText(headers[headers.length - 1][1]) : "";
  if (!candidate || /catalog|project gutenberg|contents|ebook|fran[cç]ais/i.test(candidate)) return [];
  return [{ name: candidate.replace(/^by\s+/i, "") }];
}

/** Parse the public Project Gutenberg Canada complete catalogue without requiring a DOM implementation. */
export function parseCanadaCatalog(html: string, base = SOURCE_CONFIG.pg_ca.homepage): RegionalCatalogItem[] {
  const out = new Map<string, RegionalCatalogItem>();
  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+\.epub(?:\?[^"']*)?)["'][^>]*>[\s\S]*?<\/a>/gi;
  for (const m of html.matchAll(linkRe)) {
    const href = m[1];
    const epub = absoluteUrl(href, base);
    if (!epub || !/^https:\/\/(?:www\.)?gutenberg\.ca\//i.test(epub)) continue;
    const path = new URL(epub).pathname;
    const pathId = path.match(/\/ebooks\/([^/]+)\//i)?.[1] || path.split("/").filter(Boolean).slice(-1)[0]?.replace(/\.epub$/i, "") || "";
    const around = html.slice(Math.max(0, (m.index || 0) - 1800), Math.min(html.length, (m.index || 0) + m[0].length + 1200));
    const pgc = around.match(/(?:PGC|Gutenberg\s+Canada)\s*#?\s*(\d+)/i)?.[1];
    const sourceItemId = pgc || pathId;
    if (!sourceItemId) continue;
    let title = titleFromChunk(around, href);
    if (!title) title = pathId.replace(/[-_]+/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());
    const sourceUrl = absoluteUrl(around.match(/<a\b[^>]*href\s*=\s*["']([^"']+\.html?)["']/i)?.[1] || href, base) || epub;
    const externalId = federatedExternalId("pg_ca", sourceItemId);
    out.set(externalId, {
      sourceId: "pg_ca", sourceItemId, externalId, title, authors: authorBefore(html, m.index || 0),
      languages: [/[àâçéèêëîïôûùüÿœ]/i.test(around) || /fran[cç]ais/i.test(around) ? "fr" : "en"],
      subjects: [], bookshelves: ["Project Gutenberg Canada"],
      formats: { "application/epub+zip": epub }, sourceUrl, evidenceUrl: sourceUrl, territories: ["CA"],
      metadata: { catalog: base, sourcePath: path, rightsFingerprint: stableFingerprint(cleanText(around)) },
    });
  }
  // Some older/shorter PGC editions are HTML-only. Add those as normalization candidates rather
  // than silently limiting the Canadian catalog to the subset that already has an EPUB.
  const htmlRe = /<a\b[^>]*href\s*=\s*["']([^"']+\.html?(?:\?[^"']*)?)["'][^>]*>[\s\S]*?<\/a>/gi;
  for (const m of html.matchAll(htmlRe)) {
    const href = m[1];
    const htmlAsset = absoluteUrl(href, base);
    if (!htmlAsset || !/^https:\/\/(?:www\.)?gutenberg\.ca\/ebooks\//i.test(htmlAsset)) continue;
    const path = new URL(htmlAsset).pathname;
    const pathId = path.match(/\/ebooks\/([^/]+)\//i)?.[1] || "";
    if (!pathId) continue;
    const around = html.slice(Math.max(0, (m.index || 0) - 1800), Math.min(html.length, (m.index || 0) + m[0].length + 1200));
    const pgc = around.match(/(?:PGC|PG\s*Canada|Gutenberg\s+Canada)(?:\s+ebook)?\s*#?\s*(\d+)/i)?.[1];
    const sourceItemId = pgc || pathId;
    const externalId = federatedExternalId("pg_ca", sourceItemId);
    const existing = out.get(externalId);
    if (existing) {
      existing.formats["text/html"] = htmlAsset;
      existing.sourceUrl = htmlAsset;
      continue;
    }
    let title = titleFromChunk(around, href);
    if (!title || /^(?:wikipedia|wikisource|html)$/i.test(title)) title = pathId.replace(/[-_]+/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());
    out.set(externalId, {
      sourceId: "pg_ca", sourceItemId, externalId, title, authors: authorBefore(html, m.index || 0),
      languages: [/[àâçéèêëîïôûùüÿœ]/i.test(around) || /fran[cç]ais/i.test(around) ? "fr" : "en"],
      subjects: [], bookshelves: ["Project Gutenberg Canada"],
      formats: { "text/html": htmlAsset }, sourceUrl: htmlAsset, evidenceUrl: htmlAsset, territories: ["CA"],
      metadata: { catalog: base, sourcePath: path, catalogKind: "html-fallback", rightsFingerprint: stableFingerprint(cleanText(around)) },
    });
  }
  return [...out.values()];
}

function parseCsv(text: string) {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field.trim()); field = ""; }
    else if (c === '\n') { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = ""; }
    else if (c !== '\r') field += c;
  }
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}
function columnIndex(header: string[], patterns: RegExp[]) {
  return header.findIndex((v) => patterns.some((p) => p.test(v.trim())));
}
function firstUrl(values: string[], pattern: RegExp) {
  for (const v of values) {
    const m = v.match(/https?:\/\/[^\s,"']+/i);
    if (m && pattern.test(m[0])) return m[0];
  }
  return "";
}

/** Parse the current Project Gutenberg Australia A-M / N-Z author catalogue pages.
 * Cove accepts only files hosted by Project Gutenberg Australia itself. External linked libraries
 * are deliberately ignored because their rights/provenance would need a separate source adapter.
 * A native EPUB is preferred; a trusted HTML edition is retained as a normalization fallback so
 * the commercial catalog is not limited to the subset for which PGA happened to publish an EPUB.
 */
export function parseAustraliaHtmlCatalog(html: string, base = SOURCE_CONFIG.pg_au.homepage): RegionalCatalogItem[] {
  const out = new Map<string, RegionalCatalogItem>();
  const trusted = (value: string) => /^https:\/\/(?:www\.|mail\.)?gutenberg\.net\.au\//i.test(value);
  const entryRe = /<li\b[^>]*>[\s\S]*?<\/li>/gi;
  const entries = [...html.matchAll(entryRe)];

  // A few legacy pages are not perfectly list-structured. If no <li> entries were found, create
  // bounded windows around format links rather than silently dropping the entire source.
  const chunks: { chunk: string; offset: number }[] = entries.length
    ? entries.map((m) => ({ chunk: m[0], offset: m.index || 0 }))
    : [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+\.(?:epub|html?)(?:\?[^"']*)?)["'][^>]*>[\s\S]*?<\/a>/gi)].map((m) => ({
        chunk: html.slice(Math.max(0, (m.index || 0) - 1800), Math.min(html.length, (m.index || 0) + m[0].length + 1800)),
        offset: m.index || 0,
      }));

  for (const { chunk, offset } of chunks) {
    const links = [...chunk.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((x) => ({ url: absoluteUrl(x[1], base), label: cleanText(x[2]).toLowerCase() }))
      .filter((x) => x.url && trusted(x.url));
    const epub = links.find((x) => /\.epub(?:$|[?#])/i.test(x.url) || x.label === "epub")?.url || "";
    const htmlAsset = links.find((x) => /\.html?(?:$|[?#])/i.test(x.url) && (x.label === "html" || /\/ebooks?\d*\//i.test(new URL(x.url).pathname)))?.url || "";
    if (!epub && !htmlAsset) continue;

    const identityUrl = epub || htmlAsset;
    const path = new URL(identityUrl).pathname;
    const basename = path.split("/").filter(Boolean).slice(-1)[0] || "";
    // PGA filenames normally carry a stable seven-digit ebook number (e.g. 1400441h.html).
    // Prefer that number so HTML -> EPUB changes do not create a second product identity.
    const numericId = basename.match(/(?:^|[^0-9])(\d{7})(?:[a-z])?(?:\.[a-z0-9]+)?$/i)?.[1];
    const pathId = numericId || path.replace(/^\/+/, "").replace(/\.(?:epub|html?)$/i, "").replace(/h$/i, "");
    if (!pathId) continue;

    const titleChunk = chunk.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (tag) => {
      const text = cleanText(tag);
      return /^(?:text|html|epub|mobi|kindle|pdf|zip)$/i.test(text) ? " " : ` ${text} `;
    });
    let title = cleanText(titleChunk)
      .replace(/^\s*[•*\-]+\s*/, "")
      .replace(/\s*--\s*(?:Text|HTML|EPUB|MOBI|KINDLE|PDF).*$/i, "")
      .trim();
    if (!title || title.length > 500) title = basename.replace(/\.(?:epub|html?)$/i, "").replace(/[-_]+/g, " ") || pathId;

    const sourceUrl = htmlAsset || epub;
    const formats: Record<string, string> = {};
    if (epub) formats["application/epub+zip"] = epub;
    if (htmlAsset) formats["text/html"] = htmlAsset;
    const externalId = federatedExternalId("pg_au", pathId);
    out.set(externalId, {
      sourceId: "pg_au", sourceItemId: pathId, externalId, title, authors: authorBefore(html, offset),
      languages: ["en"], subjects: [], bookshelves: ["Project Gutenberg Australia"],
      formats, sourceUrl, evidenceUrl: sourceUrl, territories: ["AU"],
      metadata: { catalog: base, sourcePath: path, catalogKind: "author-index", rightsFingerprint: stableFingerprint(cleanText(chunk)) },
    });
  }
  return [...out.values()];
}

/** Backward-compatible parser for mirrors/custom PGA feeds. Current PGA HTML is preferred, while
 * the historical catalogue.txt layout (directory, basename, extension, ...) is still understood.
 */
export function parseAustraliaCatalog(text: string, base = SOURCE_CONFIG.pg_au.homepage): RegionalCatalogItem[] {
  if (/<a\b/i.test(text)) return parseAustraliaHtmlCatalog(text, base);
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (!rows.length) return [];
  const header = rows[0].map((x) => x.toLowerCase());
  const hasHeader = header.some((x) => /title|author|ebook|file|url/.test(x));
  const start = hasHeader ? 1 : 0;
  const titleI = hasHeader ? columnIndex(header, [/^title/, /book.?title/]) : -1;
  const authorI = hasHeader ? columnIndex(header, [/author/, /creator/]) : -1;
  const idI = hasHeader ? columnIndex(header, [/ebook.*(?:no|number|id)/, /^id$/, /number/]) : -1;
  const langI = hasHeader ? columnIndex(header, [/language/, /^lang$/]) : -1;
  const epubI = hasHeader ? columnIndex(header, [/epub/]) : -1;
  const htmlI = hasHeader ? columnIndex(header, [/html/, /web.*url/, /url/]) : -1;
  const out: RegionalCatalogItem[] = [];
  for (let r = start; r < rows.length; r++) {
    const values = rows[r];
    let epubRaw = epubI >= 0 ? values[epubI] : firstUrl(values, /\.epub(?:$|\?)/i);
    if (!epubRaw && values.length >= 3 && /^(?:epub|EPUB)$/i.test(values[2] || "") && values[0] && values[1]) {
      epubRaw = `${values[0].replace(/^\/+|\/+$/g, "")}/${values[1].replace(/^\/+|\/+$/g, "")}.epub`;
    }
    const epub = epubRaw ? absoluteUrl(epubRaw, base) : "";
    if (!epub || !/^https:\/\/(?:www\.|mail\.)?gutenberg\.net\.au\//i.test(epub)) continue;
    const sourceRaw = htmlI >= 0 ? values[htmlI] : firstUrl(values, /\.html?(?:$|\?)/i);
    const sourceUrl = sourceRaw ? absoluteUrl(sourceRaw, base) : epub;
    const path = new URL(epub).pathname;
    const guessedId = path.replace(/^\/+/, "").replace(/\.epub$/i, "") || String(r + 1);
    const sourceItemId = (idI >= 0 && values[idI]) ? values[idI] : guessedId;
    let title = titleI >= 0 ? values[titleI] : "";
    if (!title) {
      const candidates = values.slice(3).filter((v) => v && !/^https?:/i.test(v) && !/^\d+$/.test(v));
      title = candidates[0] || guessedId.replace(/[-_]+/g, " ");
    }
    const author = authorI >= 0 ? values[authorI] : "";
    const lang = langI >= 0 && values[langI] ? values[langI].toLowerCase().slice(0, 5) : "en";
    out.push({
      sourceId: "pg_au", sourceItemId, externalId: federatedExternalId("pg_au", sourceItemId), title,
      authors: author ? [{ name: author }] : [], languages: [lang], subjects: [], bookshelves: ["Project Gutenberg Australia"],
      formats: { "application/epub+zip": epub }, sourceUrl, evidenceUrl: sourceUrl, territories: ["AU"],
      metadata: { catalog: base, row: r + 1, catalogKind: "legacy-csv", rightsFingerprint: stableFingerprint(values.join("|")) },
    });
  }
  return out;
}

const ISO2 = /^[A-Z]{2}$/;
function trustedEuropeOrigins(env: FederationEnv) {
  const configured = (env.FORE_GUTENBERG_EUROPE_TRUSTED_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const defaults = ["https://rastko.net", "https://www.rastko.net", "https://pge.rastko.net"];
  return new Set([...defaults, ...configured].map((x) => new URL(x).origin));
}
function assertTrustedEuropeUrl(value: string, env: FederationEnv) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !trustedEuropeOrigins(env).has(url.origin))
    throw new Error(`Untrusted Project Gutenberg Europe asset origin: ${url.origin}`);
  return url.href;
}

/**
 * Europe deliberately uses a country-scoped manifest contract. There is no safe blanket
 * "EU" grant because the historical project operated under different national copyright terms.
 */
export function parseEuropeManifest(payload: unknown, env: FederationEnv = {}): RegionalCatalogItem[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as any).items)) throw new Error("Europe feed must contain an items array.");
  const out: RegionalCatalogItem[] = [];
  for (const raw of (payload as any).items) {
    if (!raw || typeof raw !== "object" || raw.rightsStatus !== "public-domain") continue;
    const sourceItemId = String(raw.id || "").trim();
    const title = String(raw.title || "").trim();
    const territories = [...new Set((Array.isArray(raw.territories) ? raw.territories : []).map((x: unknown) => String(x).toUpperCase()).filter((x: string) => ISO2.test(x)))];
    const rawDigest = String(raw.rightsEvidenceDigest || "").trim().toLowerCase();
    const digestHex = rawDigest.replace(/^sha256:/, "");
    if (!sourceItemId || !title || !territories.length || (!raw.epubUrl && !raw.htmlUrl) || !raw.rightsEvidenceUrl || !/^[0-9a-f]{64}$/.test(digestHex)) continue;
    const evidenceDigest = `sha256:${digestHex}`;
    const formats: Record<string, string> = {};
    if (raw.epubUrl) formats["application/epub+zip"] = assertTrustedEuropeUrl(String(raw.epubUrl), env);
    if (raw.htmlUrl) formats["text/html"] = assertTrustedEuropeUrl(String(raw.htmlUrl), env);
    const evidenceUrl = assertTrustedEuropeUrl(String(raw.rightsEvidenceUrl), env);
    const sourceUrl = raw.sourceUrl ? assertTrustedEuropeUrl(String(raw.sourceUrl), env) : (formats["text/html"] || formats["application/epub+zip"] || evidenceUrl);
    out.push({
      sourceId: "pg_eu", sourceItemId, externalId: federatedExternalId("pg_eu", sourceItemId), title,
      authors: (Array.isArray(raw.authors) ? raw.authors : []).map((a: any) => ({ name: String(typeof a === "string" ? a : a?.name || "").trim() })).filter((a: any) => a.name),
      languages: (Array.isArray(raw.languages) ? raw.languages : [raw.language || "en"]).map((x: unknown) => String(x).toLowerCase()).filter(Boolean),
      subjects: Array.isArray(raw.subjects) ? raw.subjects.map(String) : [], bookshelves: ["Project Gutenberg Europe", ...(Array.isArray(raw.bookshelves) ? raw.bookshelves.map(String) : [])],
      formats, sourceUrl, evidenceUrl, territories,
      metadata: {
        manifestVersion: (payload as any).version || null, evidenceDigest,
        rightsFingerprint: stableFingerprint(JSON.stringify({ rightsStatus: raw.rightsStatus, territories, formats, evidenceUrl, evidenceDigest })),
      },
    });
  }
  return out;
}

function trustedRegionalUrl(sourceId: RegionalSourceId, value: string, env: FederationEnv) {
  const target = new URL(value);
  if (target.protocol !== "https:" || target.username || target.password || target.port) {
    throw new Error("Regional Gutenberg sources require clean HTTPS URLs.");
  }
  if (sourceId === "pg_ca" && !/^(?:www\.)?gutenberg\.ca$/i.test(target.hostname)) {
    throw new Error("Canada catalog host is not allowlisted.");
  }
  if (sourceId === "pg_au" && !/^(?:www\.|mail\.)?gutenberg\.net\.au$/i.test(target.hostname)) {
    throw new Error("Australia catalog host is not allowlisted.");
  }
  if (sourceId === "pg_eu") return new URL(assertTrustedEuropeUrl(target.href, env));
  return target;
}

export async function fetchRegionalResource(
  sourceId: RegionalSourceId,
  value: string,
  env: FederationEnv = {},
  init: Omit<RequestInit, "redirect"> = {},
) {
  let target = trustedRegionalUrl(sourceId, value, env);
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(target, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error(`${sourceId} redirect omitted Location.`);
    target = trustedRegionalUrl(sourceId, new URL(location, target).href, env);
  }
  throw new Error(`${sourceId} exceeded the redirect limit.`);
}

async function fetchCatalogDocument(sourceId: RegionalSourceId, url: string, env: FederationEnv, headers: Record<string, string> = {}) {
  const target = trustedRegionalUrl(sourceId, url, env);
  const response = await fetchRegionalResource(sourceId, target.href, env, {
    headers: { Accept: sourceId === "pg_eu" ? "application/json" : "text/html,text/plain;q=0.9,*/*;q=0.1", "User-Agent": "CoveReader/1.0 (regional public-domain catalog harvester)", ...headers },
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 304) return { status: "not-modified" as const, url: response.url || target.href, bytes: new Uint8Array(), etag: response.headers.get("etag") || "", lastModified: response.headers.get("last-modified") || "" };
  if (!response.ok) throw new Error(`${sourceId} catalog returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 12 * 1024 * 1024) throw new Error("Regional catalog exceeded 12 MiB safety limit.");
  return { status: "ok" as const, url: response.url || target.href, bytes, etag: response.headers.get("etag") || "", lastModified: response.headers.get("last-modified") || "" };
}

export async function fetchRegionalCatalog(sourceId: RegionalSourceId, env: FederationEnv = {}, headers: Record<string, string> = {}) {
  const cfg = regionalSourceConfig(sourceId, env);
  if (!cfg.catalog) return { status: "degraded" as const, items: [] as RegionalCatalogItem[], etag: "", lastModified: "", bodyHash: "", warning: "No country-scoped Project Gutenberg Europe feed is configured." };

  // PGA's current complete author catalogue is split into A-M and N-Z. Fetch both immutable-ish
  // shards in parallel; a custom operator URL can still replace them with one reviewed feed.
  const urls = sourceId === "pg_au" && "catalogShards" in cfg ? [...cfg.catalogShards] : [cfg.catalog];
  const documents = await Promise.all(urls.map((url) => fetchCatalogDocument(sourceId, url, env, urls.length === 1 ? headers : {})));
  if (documents.length === 1 && documents[0].status === "not-modified") {
    return { status: "not-modified" as const, items: [], etag: documents[0].etag, lastModified: documents[0].lastModified, bodyHash: "" };
  }
  if (documents.some((doc) => doc.status !== "ok")) throw new Error(`${sourceId} returned a partial catalog snapshot; refusing to ingest it.`);

  const hashInput = new Uint8Array(documents.reduce((n, d) => n + d.bytes.length + 1, 0));
  let offset = 0;
  for (const doc of documents) { hashInput.set(doc.bytes, offset); offset += doc.bytes.length; hashInput[offset++] = 0; }
  const bodyHash = await sha256Hex(hashInput);
  const items: RegionalCatalogItem[] = [];
  for (const doc of documents) {
    const text = new TextDecoder(sourceId === "pg_au" ? "windows-1252" : "utf-8", { fatal: false }).decode(doc.bytes);
    if (sourceId === "pg_ca") items.push(...parseCanadaCatalog(text, doc.url));
    else if (sourceId === "pg_au") items.push(...parseAustraliaCatalog(text, doc.url));
    else items.push(...parseEuropeManifest(JSON.parse(text), env));
  }
  const deduped = [...new Map(items.map((item) => [item.externalId, item])).values()];
  return {
    status: "ok" as const, items: deduped,
    etag: documents.length === 1 ? documents[0].etag : `W/\"fore-${bodyHash.slice(0, 32)}\"`,
    lastModified: documents.length === 1 ? documents[0].lastModified : "",
    bodyHash,
  };
}

const SOURCE_MARKS: Record<RegionalSourceId, RegExp[]> = {
  pg_ca: [/project\s+gutenberg\s+(?:of\s+)?canada/ig, /gutenberg\.ca/ig],
  pg_au: [/project\s+gutenberg\s+(?:of\s+)?australia/ig, /gutenberg\.net\.au/ig],
  pg_eu: [/project\s+gutenberg\s+europe/ig, /pge\.rastko\.net/ig],
};
const COPYRIGHT_EXCEPTION_PATTERNS = [
  /(?:this|the)\s+(?:ebook|e-book|work|book)[\s\S]{0,180}(?:is|remains)\s+(?:under\s+)?copyright/i,
  /distributed[\s\S]{0,120}by\s+permission/i,
  /permission\s+(?:of|from)\s+the\s+copyright\s+(?:holder|owner)/i,
  /copyrighted\s+material[\s\S]{0,160}(?:permission|license)/i,
];
function hasCopyrightException(text: string) {
  const head = text.slice(0, 120000);
  return COPYRIGHT_EXCEPTION_PATTERNS.some((p) => p.test(head));
}
function stripTrademarkBlocks(input: string, sourceId: RegionalSourceId) {
  let text = input;
  const marks = SOURCE_MARKS[sourceId];
  const sourceAddedMaterial = sourceId === "pg_au"
    ? /(?:transcriber(?:\'s|’s)?\s+note|e-?book\s+(?:was\s+)?(?:prepared|produced|created)\s+by|production\s+notes?|publisher(?:\'s|’s)?\s+note)/i
    : null;
  // Remove self-contained source header/footer blocks that carry Gutenberg project branding/licence text.
  for (let pass = 0; pass < 5; pass++) {
    const before = text;
    text = text.replace(/<(div|section|header|footer|p|pre|aside)\b[^>]*>[\s\S]{0,24000}?<\/\1>/gi, (block) => marks.some((m) => { m.lastIndex = 0; return m.test(block); }) ? "" : block);
    if (text === before) break;
  }
  // PGA's commercial-use terms additionally require removal of introductory material added by
  // the ebook creator. Remove common source-production note blocks conservatively; ambiguous
  // material that still carries source branding is caught by the post-canonicalization quarantine.
  if (sourceAddedMaterial) {
    text = text.replace(/<(div|section|header|footer|p|pre|aside)\b[^>]*>[\s\S]{0,12000}?<\/\1>/gi, (block) => sourceAddedMaterial.test(cleanText(block)) ? "" : block);
  }
  // Strip remaining source attributions from metadata-like text nodes without changing book prose broadly.
  for (const mark of marks) { mark.lastIndex = 0; text = text.replace(mark, ""); }
  return text;
}

const RESIDUAL_LICENSE_PATTERNS = [
  /copyright\s+laws?\s+(?:are|is)\s+changing/i,
  /commercial\s+use[\s\S]{0,180}(?:licen[cs]e|permission|trademark)/i,
  /you\s+may\s+(?:copy|give\s+it\s+away|re-?use)[\s\S]{0,220}(?:terms|licen[cs]e)/i,
  /(?:terms|conditions)[\s\S]{0,180}(?:distribut|redistribut|copy)[\s\S]{0,120}(?:ebook|e-book|work)/i,
];
function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function normalizedDocumentText(input: string, sourceId: RegionalSourceId) {
  // Remove executable/non-book material first; this also prevents source pages from smuggling
  // script/style text into the normalized publication.
  let value = input
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const body = value.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (body) value = body;
  value = stripTrademarkBlocks(value, sourceId);
  value = value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|footer|aside|h[1-6]|li|tr|blockquote|pre)>/gi, "\n\n")
    .replace(/<(?:p|div|section|article|header|footer|aside|h[1-6]|li|tr|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  value = decodeEntities(value).replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
  value = value.split("\n").map((line) => line.replace(/[\t ]+/g, " ").trim()).join("\n");
  value = value.replace(/\n{3,}/g, "\n\n").trim();

  // The project name itself is removed during trademark cleanup. Residual licence prose in the
  // bounded head/tail is therefore treated as an unsafe incomplete cleanup instead of guessing
  // where legal boilerplate ends and the author's text begins.
  const boundary = `${value.slice(0, 32000)}\n${value.slice(-32000)}`;
  if (RESIDUAL_LICENSE_PATTERNS.some((pattern) => pattern.test(boundary))) {
    throw new Error("Regional source licence/trademark boilerplate could not be isolated safely; item quarantined.");
  }
  if (!value || value.length < 80) throw new Error("Regional HTML source did not contain enough book text to normalize.");
  return value;
}

/** Convert a trusted regional HTML edition into a Cove-controlled EPUB.
 * This is deliberately lossy-but-safe: source presentation/branding is not carried into Cove,
 * while the author's readable text is preserved in deterministic UTF-8 XHTML chapters.
 */
export async function canonicalizeRegionalDocument(
  bytes: Uint8Array,
  sourceId: RegionalSourceId,
  options: { mimeType: "text/html"; title: string; authors?: { name: string }[]; languages?: string[]; sourceItemId?: string },
) {
  const input = new TextDecoder(sourceId === "pg_au" ? "windows-1252" : "utf-8", { fatal: false }).decode(bytes);
  if (hasCopyrightException(cleanText(input))) throw new Error("Source header indicates a copyrighted/permission-only exception; item quarantined.");
  const text = normalizedDocumentText(input, sourceId);
  const headerLines = decodeEntities(input.slice(0, 90000)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|section|h[1-6]|pre|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const labeled = (label: string) => headerLines.find((line) => new RegExp(`^${label}\\s*:`, "i").test(line))?.replace(new RegExp(`^${label}\\s*:\\s*`, "i"), "").trim() || "";
  const htmlTitle = cleanText(input.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+(?:[-–—|:]\s*)?Project Gutenberg.*$/i, "").trim();
  const title = labeled("Title") || cleanText(options.title || "") || htmlTitle || "Untitled";
  const suppliedAuthors = (options.authors || []).map((author) => ({ name: cleanText(author?.name || "") })).filter((author) => author.name);
  const headerAuthor = labeled("Author");
  const authors = suppliedAuthors.length ? suppliedAuthors : (headerAuthor ? [{ name: headerAuthor }] : []);
  const suppliedLanguages = (options.languages || []).map((language) => String(language).trim().toLowerCase()).filter(Boolean);
  const headerLanguage = labeled("Language").split(/[;,]/)[0]?.trim().toLowerCase() || "";
  const languages = [...new Set([...suppliedLanguages, ...(suppliedLanguages.length ? [] : [headerLanguage])].filter(Boolean))];
  if (!languages.length) languages.push("en");

  // Split on paragraph boundaries so no single XHTML resource grows without bound. This keeps
  // low-memory e-readers responsive and gives the renderer natural spine checkpoints.
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.replace(/\n+/g, " ").trim()).filter(Boolean);
  const chapterParagraphs: string[][] = [];
  let current: string[] = [], chars = 0;
  for (const paragraph of paragraphs) {
    if (current.length && (chars + paragraph.length > 180000 || current.length >= 320)) {
      chapterParagraphs.push(current); current = []; chars = 0;
    }
    current.push(paragraph); chars += paragraph.length;
  }
  if (current.length) chapterParagraphs.push(current);
  if (!chapterParagraphs.length) throw new Error("Regional HTML source could not be converted into readable EPUB content.");

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const manifest: string[] = [`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`];
  const spine: string[] = [];
  const nav: string[] = [];
  chapterParagraphs.forEach((chapter, index) => {
    const number = index + 1;
    const href = `chapter-${number}.xhtml`;
    const label = chapterParagraphs.length === 1 ? title : `${title} — Part ${number}`;
    const body = chapter.map((paragraph) => `<p>${xmlEscape(paragraph)}</p>`).join("\n");
    zip.file(`OEBPS/${href}`, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="${xmlEscape(languages[0])}"><head><meta charset="utf-8"/><title>${xmlEscape(label)}</title><style>body{max-width:42em;margin:0 auto;padding:1em;line-height:1.45}p{margin:.8em 0;text-indent:1.25em}h1{text-indent:0}</style></head><body>${index === 0 ? `<h1>${xmlEscape(title)}</h1>` : ""}${body}</body></html>`);
    manifest.push(`<item id="chap${number}" href="${href}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="chap${number}"/>`);
    nav.push(`<li><a href="${href}">${xmlEscape(chapterParagraphs.length === 1 ? title : `Part ${number}`)}</a></li>`);
  });
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(languages[0])}"><head><meta charset="utf-8"/><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${nav.join("")}</ol></nav></body></html>`);
  const identifier = `urn:fore:gutenberg:${sourceId}:${safeId(options.sourceItemId || title)}`;
  const creators = authors.map((author) => `<dc:creator>${xmlEscape(author.name)}</dc:creator>`).join("");
  const languageTags = languages.map((language) => `<dc:language>${xmlEscape(language)}</dc:language>`).join("");
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${xmlEscape(identifier)}</dc:identifier><dc:title>${xmlEscape(title)}</dc:title>${creators}${languageTags}<meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`);

  const output = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, mimeType: "application/epub+zip" });
  if (output.length > 30 * 1024 * 1024) throw new Error("Canonical EPUB exceeds 30 MiB delivery limit.");
  const verifyZip = await JSZip.loadAsync(output, { checkCRC32: true });
  if (!verifyZip.file("mimetype") || !verifyZip.file("META-INF/container.xml") || !verifyZip.file("OEBPS/content.opf")) throw new Error("Generated regional EPUB failed structural verification.");
  let remaining = "";
  for (const file of Object.values(verifyZip.files).filter((file) => !file.dir && /\.(?:xhtml?|html?|opf|xml|txt)$/i.test(file.name)).slice(0, 100)) remaining += "\n" + (await file.async("string")).slice(0, 160000);
  for (const mark of SOURCE_MARKS[sourceId]) { mark.lastIndex = 0; if (mark.test(remaining)) throw new Error("Gutenberg source branding remains after canonicalization; item quarantined."); }
  return { bytes: output, sha256: await sha256Hex(output), canonicalizationVersion: "regional-gutenberg-html-v1", strippedCoverCount: 0, metadata: { title, authors, languages } };
}

export async function canonicalizeRegionalEpub(bytes: Uint8Array, sourceId: RegionalSourceId) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("Source did not return an EPUB ZIP archive.");
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const opf = Object.values(zip.files).find((f) => !f.dir && /\.opf$/i.test(f.name));
  const opfText = opf ? await opf.async("string") : "";
  const firstTag = (name: string) => cleanText(opfText.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] || "");
  const allTags = (name: string) => [...opfText.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "gi"))].map((m) => cleanText(m[1])).filter(Boolean);
  const canonicalMetadata = {
    title: firstTag("dc:title"),
    authors: allTags("dc:creator").map((name) => ({ name })),
    languages: allTags("dc:language").map((language) => language.toLowerCase()).filter(Boolean),
  };

  const textual = Object.values(zip.files).filter((f) => !f.dir && /\.(?:xhtml?|html?|opf|ncx|xml|txt)$/i.test(f.name));
  if (!textual.length) throw new Error("EPUB has no inspectable text resources.");
  let inspection = "";
  for (const file of textual.slice(0, 80)) inspection += "\n" + (await file.async("string")).slice(0, 120000);
  if (hasCopyrightException(cleanText(inspection))) throw new Error("Source header indicates a copyrighted/permission-only exception; item quarantined.");

  const coverCandidates = new Set(Object.values(zip.files).filter((f) => !f.dir && /(?:^|\/)(?:pg[^/]*-)?cover[^/]*\.(?:jpe?g|png|gif|webp)$/i.test(f.name)).map((f) => f.name));
  for (const name of coverCandidates) zip.remove(name);
  for (const file of textual) {
    let value = await file.async("string");
    value = stripTrademarkBlocks(value, sourceId);
    for (const cover of coverCandidates) {
      const escaped = cover.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      value = value.replace(new RegExp(`[^"']*${escaped}`, "gi"), "");
    }
    if (/\.opf$/i.test(file.name)) {
      value = value.replace(/<meta\b[^>]*(?:name=["']cover["']|property=["']cover-image["'])[^>]*\/?\s*>/gi, "");
      value = value.replace(/<dc:publisher\b[^>]*>[\s\S]*?<\/dc:publisher>/gi, "");
      value = value.replace(/<dc:source\b[^>]*>[\s\S]*?<\/dc:source>/gi, "");
    }
    zip.file(file.name, value);
  }
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  const output = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, mimeType: "application/epub+zip" });
  if (output.length > 30 * 1024 * 1024) throw new Error("Canonical EPUB exceeds 30 MiB delivery limit.");
  const verifyZip = await JSZip.loadAsync(output);
  let remaining = "";
  for (const file of Object.values(verifyZip.files).filter((f) => !f.dir && /\.(?:xhtml?|html?|opf|ncx|xml|txt)$/i.test(f.name)).slice(0, 100)) remaining += "\n" + (await file.async("string")).slice(0, 160000);
  for (const mark of SOURCE_MARKS[sourceId]) { mark.lastIndex = 0; if (mark.test(remaining)) throw new Error("Gutenberg source branding remains after canonicalization; item quarantined."); }
  return { bytes: output, sha256: await sha256Hex(output), canonicalizationVersion: "regional-gutenberg-v2", strippedCoverCount: coverCandidates.size, metadata: canonicalMetadata };
}

export function trustedRegionalAssetUrl(sourceId: RegionalSourceId, value: string, env: FederationEnv = {}) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error("Regional Gutenberg assets require clean HTTPS URLs.");
  if (sourceId === "pg_ca" && !/^(?:www\.)?gutenberg\.ca$/i.test(u.hostname)) throw new Error("Unsupported Gutenberg Canada asset host.");
  if (sourceId === "pg_au" && !/^(?:www\.|mail\.)?gutenberg\.net\.au$/i.test(u.hostname)) throw new Error("Unsupported Gutenberg Australia asset host.");
  if (sourceId === "pg_eu") return assertTrustedEuropeUrl(u.href, env);
  return u.href;
}

export async function verifyEuropeRightsEvidence(evidenceUrl: string, digest: string, env: FederationEnv = {}) {
  const url = assertTrustedEuropeUrl(evidenceUrl, env);
  const normalized = String(digest || "").trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("Project Gutenberg Europe rights evidence digest is missing or invalid; item quarantined.");
  const response = await fetchRegionalResource("pg_eu", url, env, {
    headers: { Accept: "text/html,text/plain,application/pdf,application/json;q=0.9,*/*;q=0.1", "User-Agent": "CoveReader/1.0 (regional rights evidence verifier)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Project Gutenberg Europe rights evidence returned ${response.status}; item quarantined.`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 4 * 1024 * 1024) throw new Error("Project Gutenberg Europe rights evidence exceeded 4 MiB; item quarantined.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 4 * 1024 * 1024) throw new Error("Project Gutenberg Europe rights evidence exceeded 4 MiB; item quarantined.");
  const actual = await sha256Hex(bytes);
  if (actual !== normalized) throw new Error("Project Gutenberg Europe rights evidence digest mismatch; item quarantined.");
  return { url, sha256: actual, bytes: bytes.length };
}

export async function sha256Hex(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
