// Takes human-reviewed/forced-aligned timings; verifies files and references, then
// publishes the manifest. Does not manufacture alignment from book percentages.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";
const [editionPath, epubPath, audioDir, timingsPath, outputPath] = process.argv.slice(2);
if (!outputPath)
  throw Error(
    "Usage: node scripts/publish-biosync.mjs edition.json book.epub audio-directory verified-timings.json output.json",
  );
const edition = JSON.parse(await fs.readFile(editionPath, "utf8"));
const timing = JSON.parse(await fs.readFile(timingsPath, "utf8"));
if (
  timing.verified !== true ||
  !["chapter", "sentence"].includes(timing.precision) ||
  !timing.reviewedBy ||
  !timing.reviewedAt
)
  throw Error("A named human review and review date are required for alignment publication.");
const bytes = await fs.readFile(epubPath),
  zip = await JSZip.loadAsync(bytes);
edition.epubSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
for (const track of edition.tracks) {
  const file = path.resolve(
    audioDir,
    track.id +
      "." +
      (track.mime === "audio/mpeg" ? "mp3" : track.mime === "audio/ogg" ? "ogg" : "m4a"),
  );
  const handle = await fs.open(file);
  const hash = crypto.createHash("sha256");
  for await (const chunk of handle.createReadStream()) hash.update(chunk);
  track.sha256 = hash.digest("hex");
  track.bytes = (await fs.stat(file)).size;
  if (!track.duration)
    throw Error("Measure duration (e.g. ffprobe) for track " + track.id + " before publishing.");
}
for (const cue of timing.cues) {
  if (!cue.cfi || !cue.endCfi) throw Error("Every cue requires an exact start/end EPUB CFI.");
  const href = cue.href.split("#")[0];
  if (!Object.keys(zip.files).some((p) => p === href || p.endsWith("/" + href)))
    throw Error("Missing EPUB chapter: " + cue.href);
}
edition.alignment = { version: 1, precision: timing.precision, verified: true, cues: timing.cues };
// The API repeats shape, range, checksum-presence, and monotonicity checks.
await fs.writeFile(outputPath, JSON.stringify(edition, null, 2) + "\n");
if (process.env.FORE_SITE_URL) {
  const u = new URL("/api/fore/admin/audio", process.env.FORE_SITE_URL);
  if (u.protocol !== "https:") throw Error("HTTPS required");
  if (!process.env.FORE_SERVICE_TOKEN) throw Error("FORE_SERVICE_TOKEN required");
  const r = await fetch(u, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.FORE_SERVICE_TOKEN,
    },
    body: JSON.stringify(edition),
  });
  if (!r.ok) throw Error("Publishing failed: " + r.status + " " + (await r.text()));
  console.log("Verified alignment published.");
} else console.log("Manifest written. Set FORE_SITE_URL and FORE_SERVICE_TOKEN to publish.");
