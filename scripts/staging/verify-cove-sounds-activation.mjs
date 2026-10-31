/* eslint-disable prettier/prettier -- Keep the evidence gates and failure assertions adjacent until source normalization. */
import assert from "node:assert/strict";

const token = process.env.CLOUDFLARE_API_TOKEN || "";
assert.ok(token, "Cloudflare token is required for protected Cove Sounds release");
const root = "https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9";
const headers = { Authorization: "Bearer " + token };
const settings = await fetch(root + "/workers/scripts/cove-persistence-backend/settings", {
  headers, signal: AbortSignal.timeout(30_000),
});
assert.ok(settings.ok, "Live backend Worker settings unavailable");
const data = await settings.json();
assert.equal(data.success, true);
const bindings = data.result?.bindings || [];
const bucket = bindings.find((b) => b.name === "SOUNDS_PRESENTATION");
const kv = bindings.find((b) => b.name === "SOUNDS_PRESENTATION_KV");
const metrics = bindings.find((b) => b.name === "SOUNDS_ANALYTICS");
assert.equal(bucket?.bucket_name, "cove-sounds-private-presentation",
  "Private R2 binding must be deployed before enabling snapshots");
assert.equal(kv?.namespace_id, "544267f3cf604c1d8976f1b06d258e24",
  "Independent KV binding must be deployed before enabling snapshots");
assert.ok(metrics, "Anonymous Analytics Engine binding must be deployed");
// The scheduled publisher must not possess a production D1 capability.
const publisherReply = await fetch(root + "/workers/scripts/cove-sounds-publication/settings", {
  headers, signal: AbortSignal.timeout(30_000),
});
assert.ok(publisherReply.ok);
const publisherData = await publisherReply.json();
assert.equal(publisherData.success, true);
const publisherBindings = publisherData.result?.bindings || [];
assert.ok(!publisherBindings.some(b => b.type === "d1"), "Publisher retains a D1 capability");
assert.ok(publisherBindings.some(b => b.name === "SOUNDS_SOURCE_READER" && b.type === "service" &&
  b.service === "cove-legal-authority-production"), "Private owner source binding missing");
assert.ok(publisherBindings.some(b => b.name === "COVE_SOUNDS_SOURCE_READER_SECRET" && b.type === "secret_text"));
const paths = [
  "gothic-hour", "letters-never-sent", "beyond-the-old-woods",
  "rainlit-library", "the-long-voyage", "after-the-last-page",
];
let total = 0;
for (const slug of paths) {
  const key = encodeURIComponent("sounds/v1/US/" + slug + ".json");
  const response = await fetch(
    root + "/storage/kv/namespaces/544267f3cf604c1d8976f1b06d258e24/values/" + key,
    { headers, signal: AbortSignal.timeout(30000) },
  );
  assert.ok(response.ok, "Missing private Cove Sounds KV snapshot: " + slug);
  const record = await response.json();
  assert.equal(record.schema, "cove.sounds.station.v1");
  assert.equal(record.territory, "US");
  assert.equal(record.slug, slug);
  assert.ok(Date.now() < record.expiresAt && record.expiresAt < Date.now() + 90 * 60_000);
  assert.ok(Array.isArray(record.recordings) && record.recordings.length <= 8);
  assert.ok(Array.isArray(record.candidateProductIds) &&
    record.candidateProductIds.length <= 12);
  assert.ok(record.recordings.every((r) =>
    r.audioUrl === "/api/fore/soundtracks/recordings/" + r.id + "/audio"));
  total += record.recordings.length;
}
assert.ok(total > 0, "No approved production recordings in isolated projections");
console.log(JSON.stringify({
  event: "cove-sounds-activation-preflight",
  completeStations: paths.length, referenceRecordings: total,
  canonicalRightsBypassed: false,
}));
