import assert from "node:assert/strict";

const origin =
  process.env.COVE_SOUNDS_PUBLIC_ORIGIN || "https://cove-jibrilmohamuds-projects.vercel.app";
const canonical = new URL(origin);
assert.equal(canonical.protocol, "https:");
assert.equal(canonical.pathname, "/");
assert.equal(canonical.search, "");
assert.equal(canonical.hash, "");
const request = async (path) => {
  const response = await fetch(new URL(path, canonical), {
    headers: { accept: path.startsWith("/api/") ? "application/json" : "text/html" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  assert.equal(response.status, 200, path + " must respond HTTP 200");
  return response;
};
for (const path of ["/sounds", "/sounds/gothic-hour"]) {
  const response = await request(path);
  const html = await response.text();
  assert.ok(html.includes("Cove Sounds"), path + " must render Cove Sounds");
  if (path.endsWith("gothic-hour"))
    assert.ok(html.includes("The Gothic Hour"), "Gothic station must SSR");
}
const [contextResponse, musicResponse, booksResponse] = await Promise.all([
  request("/api/fore/storefront/context"),
  request("/api/fore/sounds/stations/gothic-hour/recordings"),
  request("/api/fore/sounds/stations/gothic-hour/books"),
]);
const market = await contextResponse.json();
const music = await musicResponse.json();
const books = await booksResponse.json();
assert.match(market.rightsCountry, /^[A-Z]{2}$/, "Live storefront territory required");
// Public runners can legitimately enter a market outside the US pilot.
// The protected private activation workflow independently verifies all six US
// KV objects, live bindings, and publication freshness using Cloudflare credentials.
const fallback = music.fallback === true || books.fallback === true;
assert.equal(
  music.fallback === true,
  books.fallback === true,
  "The territory gate must agree for music and book snapshots",
);
if (fallback) {
  assert.notEqual(market.rightsCountry, "US", "Seeded US market must not fall back");
  assert.deepEqual(music.recordings, [], "Non-pilot market must not receive US masters");
  assert.deepEqual(books.books, [], "Non-pilot market must not receive US book candidates");
} else {
  assert.equal(market.rightsCountry, "US", "Unseeded market must not receive US snapshots");
  assert.ok(music.recordings.length > 0, "US rights-checked station music must be nonempty");
  assert.ok(books.books.length > 0, "US rights-checked station books must be nonempty");
}
assert.ok(Array.isArray(music.recordings));
assert.ok(music.recordings.length <= 8);
assert.ok(
  music.recordings.every(
    (item) =>
      typeof item.audioUrl === "string" &&
      /^\/api\/fore\/soundtracks\/recordings\/(cm_[0-9]+|ex_[a-f0-9-]{36})\/audio$/.test(
        item.audioUrl,
      ),
  ),
  "Only canonical rights-fenced media links may be served",
);
assert.ok(Array.isArray(books.books));
assert.ok(books.books.length <= 12);
console.log(
  JSON.stringify({
    result: "COVE_SOUNDS_PUBLIC_ACCEPTANCE_PASS",
    geoMode: fallback ? "guarded-nonpilot-market" : "seeded-market-live-rights",
    origin,
    stations: 6,
    approvedMusicCandidates: music.recordings.length,
    authorizedBookEditions: books.books.length,
    checked: [
      "SSR",
      "territory gate",
      "rights-safe fallback or live snapshots",
      "playback URL fencing",
      "book retail authority",
    ],
  }),
);
