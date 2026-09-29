import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { localBindings } from "./local-api.mjs";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fore-store-"));
fs.cpSync("drizzle", path.join(scratch, "drizzle"), { recursive: true });
await build({
  entryPoints: ["src/features/fore/api.server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(scratch, "api.mjs"),
  logLevel: "silent",
});
const { handleCoveApi } = await import(path.join(scratch, "api.mjs"));
const env = { ...localBindings(scratch), FORE_INGEST_TOKEN: "fixture-operator-secret" };
let checks = 0;
async function req(route, method = "GET", body, user = "alice", extra = {}) {
  const headers = { "Content-Type": "application/json", Origin: "https://fore.test", ...extra };
  if (user) headers["oai-authenticated-user-id"] = user;
  const response = await handleCoveApi(
    new Request("https://fore.test/api/fore" + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: response.status, body: await response.json() };
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks++;
}
await req("/profile", "POST", { name: "Alice" });
await req("/profile", "POST", { name: "Bob" }, "bob");
let catalogSearch = await req("/catalog?search=pride&language=en", "GET", undefined, null);
eq(catalogSearch.status, 200, "FTS catalog search responds");
eq(catalogSearch.body.search.backend, "d1-fts5", "D1 FTS5 is the local resilient search backend");
eq(catalogSearch.body.results.some((b) => String(b.id) === "1342"), true, "Title search finds Pride and Prejudice");
eq(catalogSearch.body.facets.languages.some((x) => x.value === "en"), true, "Search returns language facets");
let authorSearch = await req("/catalog?search=Austen&language=en", "GET", undefined, null);
eq(authorSearch.body.results.some((b) => String(b.id) === "1342"), true, "Author matching is indexed");
let idSearch = await req("/catalog?search=1342&language=en", "GET", undefined, null);
eq(idSearch.body.results[0]?.id?.toString(), "1342", "Exact external identifier lookup is boosted");
let suggestions = await req("/search/suggest?q=prid", "GET", undefined, null);
eq(suggestions.status, 200, "Autocomplete endpoint responds");
eq(suggestions.body.suggestions.some((x) => String(x.bookId) === "1342"), true, "Autocomplete returns matching title");
if (catalogSearch.body.search.queryId && catalogSearch.body.results[0]?.productId) {
  eq((await req("/search/click", "POST", { queryId: catalogSearch.body.search.queryId, productId: catalogSearch.body.results[0].productId, position: 1 }, null)).status, 200, "Search result click attribution persists");
}
eq(
  (await req("/books/1342/reviews", "PUT", { rating: 0.5 }, null)).status,
  401,
  "Rating requires identity",
);
eq(
  (await req("/books/1342/reviews", "PUT", { rating: 0.7 })).status,
  400,
  "Only half stars accepted",
);
eq(
  (
    await req("/books/1342/reviews", "PUT", {
      rating: 0.5,
      body: "Private words",
      visibility: "private",
    })
  ).status,
  200,
  "Private half-star rating",
);
let result = await req("/books/1342/reviews", "GET", undefined, null);
eq(result.body.summary.count, 0, "Private excluded from average");
eq(result.body.reviews.length, 0, "Private excluded from feed");
eq(result.body.mine, null, "No anonymous private record");
result = await req("/books/1342/reviews");
eq(result.body.mine.rating, 0.5, "Owner sees private rating");
eq(result.body.mine.body, "Private words", "Owner sees private text");
await req("/books/1342/reviews", "PUT", {
  rating: 4.5,
  body: "A lovely nuanced story.",
  visibility: "public",
  spoiler: true,
});
let mine = (await req("/books/1342/reviews")).body.mine;
eq((await req("/reviews/" + mine.id + "/heart", "PUT", {})).status, 400, "Self-heart prevented");
eq((await req("/reviews/" + mine.id + "/heart", "PUT", {}, "bob")).status, 200, "Heart accepted");
await req("/reviews/" + mine.id + "/heart", "PUT", {}, "bob");
result = await req("/books/1342/reviews", "GET", undefined, "bob");
eq(result.body.reviews[0].hearts, 1, "Hearts are idempotent");
eq(result.body.reviews[0].hearted, true, "Viewer heart state");
eq(result.body.reviews[0].userId, undefined, "No public user IDs");
await req("/books/1342/reviews", "PUT", { rating: 3, visibility: "public" }, "bob");
result = await req("/books/1342/reviews", "GET", undefined, null);
eq(result.body.summary.average, 3.75, "Public average includes rating-only");
eq(result.body.reviews.length, 2, "Rating-only record listed");
eq((await req("/books/1342/reviews?rating=4.5")).body.count, 1, "Exact half-star filter");
eq((await req("/books/1342/reviews?textOnly=true")).body.count, 1, "Written-only filter");
for (const sort of ["popular", "trending", "new", "longest", "shortest"])
  eq((await req("/books/1342/reviews?sort=" + sort)).status, 200, "Supported sort " + sort);
eq((await req("/books/1342/reviews?sort=sql")).status, 400, "Invalid sort rejected");
eq(
  (await req("/books/1342/reviews?sort=longest")).body.reviews[0].wordCount,
  4,
  "Word count calculated server-side",
);
eq(
  (await req("/reviews/" + mine.id + "/report", "POST", { reason: "spam" }, "bob")).status,
  200,
  "Report saved",
);
eq(
  (await req("/admin/reports", "GET", undefined, "bob")).status,
  410,
  "Legacy moderation endpoint retired",
);
eq(
  (
    await req("/admin/reports", "PATCH", { id: mine.id, moderation: "hidden" }, null, {
      Authorization: "Bearer fixture-operator-secret",
    })
  ).status,
  410,
  "Ingestion/operator credential cannot moderate reader reviews",
);
await req("/books/1342/reviews", "PUT", {
  rating: 4,
  body: "Private again",
  visibility: "private",
});
eq(
  (await req("/books/1342/reviews", "GET", undefined, "bob")).body.reviews.length,
  1,
  "Privacy change removes publication",
);
eq(
  (await req("/reviews/" + mine.id + "/heart", "DELETE", {}, "bob")).status,
  404,
  "Private review cannot be probed",
);
const shelf = (await req("/shelves", "POST", { name: "Rainy days", description: "Quiet reads" }))
  .body.id;
eq(
  (await req("/shelves/" + shelf, "GET", undefined, "bob")).status,
  404,
  "Private shelf IDOR blocked",
);
eq(
  (await req("/shelves/" + shelf, "PATCH", { name: "Stolen" }, "bob")).status,
  404,
  "Shelf ownership enforced",
);
await req("/shelves/" + shelf + "/books", "PUT", { bookId: "1342" });
await req("/shelves/" + shelf + "/books", "PUT", { bookId: "11" });
await req("/shelves/" + shelf + "/books", "PUT", { bookId: "1342" });
eq((await req("/shelves/" + shelf)).body.books.length, 2, "No duplicate shelf members");
eq((await req("/shelves/" + shelf + "/order", "PUT", { bookIds: ["11", "1342"] })).status, 200);
eq((await req("/shelves/" + shelf)).body.books[0].bookId, "11", "Shelf order persisted");
eq(
  (await req("/shelves/" + shelf + "/order", "PUT", { bookIds: ["11", "11"] })).status,
  409,
  "Invalid reorder rejected",
);
await req("/shelves/" + shelf, "PATCH", { name: "Rainy days", visibility: "public" });
eq(
  (await req("/shelves/" + shelf, "GET", undefined, null)).body.books.length,
  2,
  "Public shelf readable",
);
await req("/library", "POST", { bookId: "1342", status: "finished" });
await req("/library", "POST", { bookId: "1342", status: "finished" });
await req("/metrics", "PUT", {
  bookId: "1342",
  wordCount: 120000,
  readingLevel: 9.3,
  language: "en",
});
const session = {
  id: crypto.randomUUID(),
  bookId: "1342",
  mode: "read",
  startedAt: new Date(Date.now() - 120000).toISOString(),
  endedAt: new Date().toISOString(),
  activeSeconds: 60,
  wordsRead: 240,
};
eq((await req("/sessions", "PUT", session)).status, 200);
await req("/sessions", "PUT", session);
await req("/sessions", "PUT", { ...session, activeSeconds: 30, wordsRead: 100 });
let stats = (await req("/stats?days=30")).body;
eq(stats.totals.readSeconds, 60, "Duplicate/replayed sessions do not double count or regress");
eq(stats.totals.wpm, 240, "Weighted reading pace");
eq(stats.totals.finished, 1, "Only one completion per status transition");
eq(stats.totals.averageBookWords, 120000, "Measured book length");
eq(
  (await req("/sessions", "PUT", { ...session, mode: "listen" })).status,
  409,
  "Cannot repurpose a session ID",
);
eq(
  (await req("/sessions", "PUT", { ...session, id: crypto.randomUUID(), activeSeconds: 10000 }))
    .status,
  400,
  "Implausible active time rejected",
);
eq((await req("/stats", "GET", undefined, "bob")).body.totals.readSeconds, 0, "Stats private");
await req("/goals", "PUT", { year: new Date().getUTCFullYear(), books: 12 });
eq((await req("/stats")).body.goal.target, 12, "Goal persisted");
await req("/definitions", "POST", {
  word: "abstruse",
  meaning: "Difficult to understand",
  bookId: "1342",
});
eq(
  (await req("/stats")).body.vocabulary[0].word,
  "abstruse",
  "Vocabulary sourced from saved words",
);
const edition = {
  id: "pg-fixture",
  gutenbergId: "20686",
  bookId: "1342",
  title: "Fixture",
  authors: [{ name: "Author" }],
  language: "en",
  narration: "human",
  narrator: "Voice",
  sourceUrl: "https://www.gutenberg.org/ebooks/20686",
  rights: "Public domain in the USA.",
  tracks: [
    {
      id: "01",
      title: "One",
      url: "https://www.gutenberg.org/files/20686/one.mp3",
      mime: "audio/mpeg",
      duration: 90,
    },
  ],
  alignment: null,
  epubSha256: null,
};
eq((await req("/admin/audio", "PUT", edition)).status, 403, "Ingestion protected");
eq(
  (
    await req("/admin/audio", "PUT", edition, null, {
      Authorization: "Bearer fixture-operator-secret",
    })
  ).status,
  200,
  "Valid audio import",
);
eq(
  (
    await req("/admin/audio", "PUT", { ...edition, rights: "Copyrighted" }, null, {
      Authorization: "Bearer fixture-operator-secret",
    })
  ).status,
  400,
  "Recording rights enforced",
);
eq(
  (
    await req(
      "/admin/audio",
      "PUT",
      { ...edition, tracks: [{ ...edition.tracks[0], url: "https://evil.test/private" }] },
      null,
      { Authorization: "Bearer fixture-operator-secret" },
    )
  ).status,
  400,
  "Untrusted media source rejected",
);
await env.BUCKET.put(
  "audio/pg-fixture/01-" + encodeURIComponent(edition.tracks[0].url),
  new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
);
async function media(range, method = "GET") {
  return handleCoveApi(
    new Request("https://fore.test/api/fore/audio/pg-fixture/tracks/01", {
      method,
      headers: range ? { Range: range } : {},
    }),
    env,
  );
}
let response = await media("bytes=2-5");
eq(response.status, 206, "Range response");
eq(response.headers.get("content-range"), "bytes 2-5/10");
eq([...new Uint8Array(await response.arrayBuffer())], [2, 3, 4, 5]);
response = await media("bytes=-3");
eq([...new Uint8Array(await response.arrayBuffer())], [7, 8, 9]);
eq((await media("bytes=99-")).status, 416, "Unsatisfiable range");
eq((await media(null, "HEAD")).headers.get("content-length"), "10", "HEAD size");
let play = await req("/audio/pg-fixture/playback", "PUT", {
  trackId: "01",
  seconds: 15,
  speed: 1.25,
  version: 0,
});
eq(play.status, 200, "Playback saved");
eq(
  (
    await req("/audio/pg-fixture/playback", "PUT", {
      trackId: "01",
      seconds: 20,
      speed: 1,
      version: 0,
    })
  ).status,
  409,
  "Stale playback rejected",
);
eq(
  (await req("/audio/pg-fixture/playback", "GET", undefined, "bob")).body,
  null,
  "Playback isolated",
);
eq(
  (
    await req("/audio/pg-fixture/playback", "PUT", {
      trackId: "wrong",
      seconds: 0,
      speed: 1,
      version: 1,
    })
  ).status,
  400,
  "Invalid track rejected",
);
await req("/sessions", "PUT", {
  ...session,
  id: crypto.randomUUID(),
  mode: "listen",
  activeSeconds: 60,
  wordsRead: 0,
});
stats = (await req("/stats")).body;
eq(stats.totals.listenSeconds, 60);
eq(stats.totals.wpm, 240, "Listening excluded from WPM");
eq((await req("/export", "GET", undefined, null)).status, 401);
eq(
  (await req("/export", "GET", undefined, "bob")).body.reading_sessions.length,
  0,
  "Export ownership",
);
const csrf = await req("/books/1342/reviews", "PUT", { rating: 5 }, "bob", {
  Origin: "https://evil.test",
});
eq(csrf.status, 403, "Cross-site writes blocked");
await req("/shelves/" + shelf, "DELETE", {});
eq(
  (
    await env.DB.prepare("SELECT COUNT(*) count FROM shelf_books WHERE shelf_id=?")
      .bind(shelf)
      .first()
  ).count,
  0,
  "Shelf cascade cleanup",
);
await req("/books/1342/reviews", "DELETE", {});
eq((await req("/books/1342/reviews")).body.mine, null, "Deleted reviews do not reappear");
const aligned = {
  ...edition,
  epubSha256: "a".repeat(64),
  tracks: [{ ...edition.tracks[0], sha256: "b".repeat(64) }],
  alignment: {
    version: 1,
    verified: true,
    precision: "chapter",
    cues: [
      {
        trackId: "01",
        start: 0,
        end: 90,
        progress: 0,
        endProgress: 1,
        href: "chapter.xhtml",
        cfi: "epubcfi(/6/2!/4/2/1:0)",
        endCfi: "epubcfi(/6/4!/4/2/1:0)",
        label: "One",
      },
    ],
  },
};
const operator = { Authorization: "Bearer fixture-operator-secret" };
eq(
  (await req("/admin/audio", "PUT", aligned, null, operator)).status,
  200,
  "Verified complete alignment accepted",
);
eq(
  (await req("/admin/audio", "PUT", edition, null, operator)).status,
  409,
  "Catalog refresh cannot erase verified map",
);
eq(
  (await req("/admin/audio", "PUT", { ...aligned, tracks: edition.tracks }, null, operator)).status,
  400,
  "Alignment without audio checksum rejected",
);
eq(
  (
    await req(
      "/admin/audio",
      "PUT",
      {
        ...aligned,
        alignment: { ...aligned.alignment, cues: [{ ...aligned.alignment.cues[0], end: 91 }] },
      },
      null,
      operator,
    )
  ).status,
  400,
  "Out-of-track cue rejected",
);
eq(
  (
    await req(
      "/admin/audio",
      "PUT",
      { ...aligned, alignment: { ...aligned.alignment, verified: false } },
      null,
      operator,
    )
  ).status,
  400,
  "Unverified alignment rejected",
);
await assert.rejects(
  env.BUCKET.put("bad-hash", new Uint8Array([1, 2]), { sha256: "b".repeat(64) }),
);
checks++;
eq(await env.BUCKET.head("bad-hash"), null, "Failed integrity check is never published");
console.log(
  `PASS: ${checks} assertions covering private/public reviews, half-stars, hearts, sorting, moderation, shelf ownership/order, activity idempotency, stats isolation, media rights, byte ranges, playback conflicts, and export privacy.`,
);
fs.rmSync(scratch, { recursive: true, force: true });
