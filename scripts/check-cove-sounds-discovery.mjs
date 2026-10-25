import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const code = await build({
  entryPoints: ["src/features/fore/cove-sounds-stations.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "es2022",
  logLevel: "silent",
});
const module = await import(
  "data:text/javascript;base64," + Buffer.from(code.outputFiles[0].text).toString("base64")
);
const { COVE_SOUNDS_STATIONS, stationBySlug, stationRecordings } = module;
assert.ok(COVE_SOUNDS_STATIONS.length >= 4);
const slugs = COVE_SOUNDS_STATIONS.map((s) => s.slug);
assert.equal(new Set(slugs).size, slugs.length, "Station slugs must remain unique");
for (const station of COVE_SOUNDS_STATIONS) {
  assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(station.slug));
  assert.ok(station.books.length >= 2);
  assert.ok(station.moods.length >= 2);
  assert.equal(stationBySlug(station.slug), station);
  assert.ok(station.accent.startsWith("#"));
  for (const b of station.books) assert.ok(b.title && b.author);
}
assert.equal(stationBySlug("unknown"), undefined);
const gothic = stationBySlug("gothic-hour");
const recordings = [
  {
    id: "safe",
    audioUrl: "/api/fore/soundtracks/recordings/cm_7/audio",
    title: "Nocturne",
    moods: ["dark", "melancholy"],
    instruments: ["piano"],
    energy: 0.3,
    hasVocals: false,
  },
  {
    id: "safe-alt",
    audioUrl: "/api/fore/soundtracks/recordings/ex_00000000-0000-0000-0000-000000000000/audio",
    title: "Quiet strings",
    moods: [],
    instruments: ["violin"],
    energy: 0.4,
    hasVocals: false,
  },
  {
    id: "vocal",
    audioUrl: "/api/fore/soundtracks/recordings/cm_8/audio",
    title: "Song",
    moods: ["dark"],
    instruments: ["piano"],
    energy: 0.2,
    hasVocals: true,
  },
  {
    id: "ineligible",
    audioUrl: "/admin/soundtracks/recordings/cm_9/audio",
    title: "Private review",
    moods: ["dark"],
    instruments: ["piano"],
    energy: 0.2,
    hasVocals: false,
  },
  {
    id: "missing",
    audioUrl: "",
    title: "No media",
    moods: ["dark"],
    instruments: ["piano"],
    energy: 0.2,
    hasVocals: false,
  },
  {
    id: "unrelated",
    audioUrl: "/api/fore/soundtracks/recordings/cm_10/audio",
    title: "Dance",
    moods: ["joyful"],
    instruments: ["drums"],
    energy: 0.8,
    hasVocals: false,
  },
];
const ranked = stationRecordings(gothic, recordings);
assert.deepEqual(
  ranked.map((r) => r.id),
  ["safe", "safe-alt"],
);
assert.deepEqual(stationRecordings(gothic, []), []);
assert.ok(readFileSync("src/routes/sounds.tsx", "utf8").includes('createFileRoute("/sounds")'));
assert.ok(
  readFileSync("src/routes/sounds_.$slug.tsx", "utf8").includes('createFileRoute("/sounds/$slug")'),
);
assert.ok(readFileSync("src/routeTree.gen.ts", "utf8").includes("SoundsSlugRoute"));
const view = readFileSync("src/features/fore/CoveSounds.tsx", "utf8");
assert.ok(view.includes('api<RecordingCatalog>("/soundtracks/recordings")'));
assert.ok(view.includes('"/books/" + encodeURIComponent(id) + "/literary-profile/playlist'));
assert.ok(view.includes('visibility: "public"'));
assert.ok(view.includes('"/social/lists", "POST"'));
assert.ok(
  view.includes('"/social/sounds/stations/" + station.slug + "/shelves"'),
  "Creator shelves must use the bounded dedicated endpoint.",
);
assert.ok(!view.includes('"/social/discover"'), "Do not load broad member, list and group discovery.");
assert.ok(view.includes('enabled: checkBooks && typeof window !== "undefined"'));
assert.ok(view.includes('enabled: listenRequested && typeof window !== "undefined"'));
assert.ok(view.includes('enabled: browse && typeof window !== "undefined"'));
const social = readFileSync("src/features/fore/social.server.ts", "utf8");
assert.ok(social.includes('LIMIT 9'), "Only one bounded page of shelves can be scanned.");
assert.ok(social.includes("sp.profile_visibility='public'"));
assert.ok(social.includes("l.visibility='public'"));
assert.ok(social.includes("l.moderation_status='visible'"));
assert.ok(social.includes("a.disabled_at IS NULL"));
assert.ok(social.includes("social_blocks b"));
assert.ok(social.includes("social_mutes m"));
assert.ok(social.includes("nextCursor: rows.length > 8"));
assert.ok(social.includes("stationBySlug(soundsShelvesRoute[1])"));

assert.ok(view.includes('"/catalog?search="'));
assert.ok(view.includes("navigator.canShare?.({ files: [file] })"));
assert.ok(view.includes('document.querySelectorAll<HTMLAudioElement>("audio")'));
assert.ok(!view.includes("autoPlay"), "Music must always require a user action");
const nav = readFileSync("src/features/fore/App.tsx", "utf8");
assert.ok(nav.includes('["/sounds", "nav.sounds", "Cove Sounds", Music2]'));
console.log(
  "PASS: Cove Sounds editorial stations, opt-in rights and catalog reads, bounded private-aware creator pagination, recording and attribution controls, share artwork, no autoplay",
);
