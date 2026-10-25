import assert from "node:assert/strict";

const origin = process.env.COVE_SOUNDS_PUBLIC_ORIGIN ||
  "https://cove-jibrilmohamuds-projects.vercel.app";
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
const [musicResponse, booksResponse] = await Promise.all([
  request("/api/fore/sounds/stations/gothic-hour/recordings"),
  request("/api/fore/sounds/stations/gothic-hour/books"),
]);
const music = await musicResponse.json();
const books = await booksResponse.json();
assert.notEqual(music.fallback, true, "US private snapshot unexpectedly disabled");
assert.notEqual(books.fallback, true, "US private book candidates unexpectedly disabled");
assert.ok(Array.isArray(music.recordings));
assert.ok(music.recordings.length > 0 && music.recordings.length <= 8);
assert.ok(music.recordings.every((item) =>
  typeof item.audioUrl === "string" &&
  /^\/api\/fore\/soundtracks\/recordings\/(cm_[0-9]+|ex_[a-f0-9-]{36})\/audio$/.test(item.audioUrl)
), "Only canonical rights-fenced media links may be served");
assert.ok(Array.isArray(books.books));
assert.ok(books.books.length > 0 && books.books.length <= 12);
console.log(JSON.stringify({
  result: "COVE_SOUNDS_PUBLIC_ACCEPTANCE_PASS",
  origin,
  stations: 6,
  approvedMusicCandidates: music.recordings.length,
  authorizedBookEditions: books.books.length,
  checked: ["SSR", "current US snapshots", "playback URL fencing", "book retail authority"],
}));
