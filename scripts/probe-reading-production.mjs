import fs from "node:fs";
import { performance } from "node:perf_hooks";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
const origin = process.env.COVE_PROBE_ORIGIN || "https://cove-puce-theta.vercel.app";
const userAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 CoveReliabilityProbe/1.0";
const timings = [];
for (const route of [
  "/",
  "/api/fore/storefront/bootstrap",
  "/api/fore/catalog?limit=12",
  "/api/fore/catalog?search=Frankenstein&limit=12",
]) {
  for (const phase of ["first-observed", "repeat"]) {
    const started = performance.now();
    try {
      const response = await fetch(new URL(route, origin), {
          headers: { "User-Agent": userAgent },
          signal: AbortSignal.timeout(45000),
        }),
        ttfb = performance.now() - started,
        body = await response.text();
      timings.push({
        path: route,
        phase,
        status: response.status,
        ttfbMs: Math.round(ttfb),
        totalMs: Math.round(performance.now() - started),
        bytes: Buffer.byteLength(body),
        cache: response.headers.get("x-cove-backend-cache"),
        serverTiming: response.headers.get("server-timing"),
        ...(route === "/"
          ? { serverRenderedBooks: (body.match(/class="book-card"/g) || []).length }
          : {}),
      });
    } catch (error) {
      timings.push({
        path: route,
        phase,
        error: error.message,
        totalMs: Math.round(performance.now() - started),
      });
    }
  }
}
const books = [];
for (const id of (process.env.COVE_PROBE_BOOK_IDS || "1342,84,24923,21609,166,11666")
  .split(",")
  .slice(0, 12)) {
  if (!/^\d+$/.test(id)) throw Error("Probe only accepts explicit public Gutenberg source IDs");
  const started = performance.now();
  try {
    const response = await fetch(new URL(`/api/fore/books/${id}/epub`, origin), {
      headers: { "User-Agent": userAgent },
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 25 * 1024 * 1024) throw Error("Oversized EPUB");
    const zip = await JSZip.loadAsync(bytes);
    if ((await zip.file("mimetype")?.async("string")) !== "application/epub+zip")
      throw Error("Invalid EPUB mimetype");
    const parse = (text) =>
      new DOMParser({
        errorHandler: {
          warning: (m) => {
            throw Error(m);
          },
          error: (m) => {
            throw Error(m);
          },
          fatalError: (m) => {
            throw Error(m);
          },
        },
      }).parseFromString(text, "application/xml");
    const container = parse(await zip.file("META-INF/container.xml").async("string"));
    const packagePath = container
      .getElementsByTagNameNS("*", "rootfile")[0]
      .getAttribute("full-path");
    const opf = parse(await zip.file(packagePath).async("string")),
      items = new Map(
        Array.from(opf.getElementsByTagNameNS("*", "item")).map((n) => [
          n.getAttribute("id"),
          n.getAttribute("href"),
        ]),
      );
    const spine = Array.from(opf.getElementsByTagNameNS("*", "itemref"));
    if (!spine.length) throw Error("Empty spine");
    for (const item of spine) {
      const href = items.get(item.getAttribute("idref"));
      const target = new URL(href, "https://epub.invalid/" + packagePath);
      if (target.origin !== "https://epub.invalid") throw Error("Remote spine");
      parse(await zip.file(decodeURIComponent(target.pathname.slice(1))).async("string"));
    }
    books.push({
      id,
      status: response.status,
      bytes: bytes.byteLength,
      chapters: spine.length,
      validated: true,
      totalMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    books.push({
      id,
      validated: false,
      error: error.message,
      totalMs: Math.round(performance.now() - started),
    });
  }
}
const report = {
  observedAt: new Date().toISOString(),
  origin,
  boundary:
    "Public read-only probes; network/proxy timing, not field Core Web Vitals or empty-cache guarantees. Book reads may hydrate an approved public source through Cove.",
  timings,
  books,
};
if (process.env.COVE_PROBE_OUTPUT)
  fs.writeFileSync(process.env.COVE_PROBE_OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (timings.some((r) => r.status !== 200) || books.some((r) => !r.validated)) process.exitCode = 1;
