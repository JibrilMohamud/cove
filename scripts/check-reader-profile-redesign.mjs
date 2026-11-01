import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const file = (name) => readFileSync(name, "utf8");
const route = file("src/routes/community.tsx");
const profile = file("src/features/fore/ReaderProfileOverview.tsx");
const sections = file("src/features/fore/ReaderProfileSections.tsx");
const rails = file("src/features/fore/ReaderProfileRail.tsx");
const actions = file("src/features/fore/CommunityProfileRoute.tsx");
assert.match(route, /CommunityProfileRoute/);
assert.match(route, /CommunityPage/);
for (const name of [
  "Profile",
  "Activity",
  "Library",
  "Journal",
  "Reviews",
  "Shelves",
  "Conversation",
  "Stats",
]) {
  assert.ok(profile.includes(name), name);
}
assert.match(profile, /toLocaleString/);
assert.match(sections, /top\.filter/);
assert.match(sections, /selected\.length\s*>\s*0/);
assert.match(sections, /shelves\.length\s*>\s*0/);
assert.match(sections, /reviews\.length\s*>\s*0/);
assert.match(sections, /owner\s*&&/);
assert.match(rails, /current\?\.book/);
assert.match(actions, /data\.user\?\.id \|\| "guest"/);
console.log("Reader profile regression checks passed");
