/* eslint-disable prettier/prettier -- Private bounded analytics aggregation and regression fixtures are kept together for auditability. */
import assert from "node:assert/strict";
import {
  buildSoundsFunnelSql, summarizeSoundsFunnel, renderSoundsFunnelMarkdown,
} from "./staging/cove-sounds-funnel-report-lib.mjs";
const sql = buildSoundsFunnelSql(7);
assert.match(sql, /FROM cove_sounds_funnel/);
assert.match(sql, /sum\(_sample_interval\)/);
assert.match(sql, /LIMIT 1500/);
assert.doesNotMatch(sql, /user_id|order_id|product_id|ip_address|cookie/i);
assert.throws(() => buildSoundsFunnelSql(31), /Invalid/);
assert.throws(() => buildSoundsFunnelSql("7';DROP TABLE"), /Invalid/);
const entries = [
  { station: "gothic-hour", event: "station_view", recording: "none", territory: "US", estimated_events: 100 },
  { station: "gothic-hour", event: "music_open", recording: "none", territory: "US", estimated_events: 30 },
  { station: "gothic-hour", event: "book_open", recording: "cm_123", territory: "US", estimated_events: 20 },
  { station: "gothic-hour", event: "reading_started", recording: "cm_123", territory: "US", estimated_events: 5 },
  { station: "gothic-hour", event: "purchase_observed", recording: "cm_123", territory: "US", estimated_events: 2 },
  { station: "gothic-hour", event: "share", recording: "cm_123", territory: "US", estimated_events: 10 },
  { station: "gothic-hour", event: "book_open", recording: "none", territory: "US", estimated_events: 7 },
  { station: "some-user-supplied-text", event: "book_open", recording: "cm_123", territory: "US", estimated_events: 1000 },
  { station: "gothic-hour", event: "bad-event", recording: "cm_123", territory: "US", estimated_events: 1000 },
  { station: "gothic-hour", event: "share", recording: "cm_123", territory: "US", estimated_events: -3 },
  { station: "gothic-hour", event: "share", recording: "cm_123", territory: "XX_USER_ID", estimated_events: 1000 },
];
const summary = summarizeSoundsFunnel(entries);
assert.equal(summary.stations.length, 6);
const gothic = summary.stations.find((s) => s.station === "gothic-hour");
assert.deepEqual([gothic.station_view, gothic.music_open, gothic.book_open,
  gothic.reading_started, gothic.purchase_observed, gothic.share],
[100, 30, 27, 5, 2, 10]);
assert.equal(summary.recordings.length, 1);
assert.deepEqual([summary.recordings[0].book_open, summary.recordings[0].share], [20, 10]);
const report = renderSoundsFunnelMarkdown(summary, 7);
assert.match(report, /30\.0 \| 27\.0 \| 5\.0 \| 2\.0 \|/);
assert.match(report, /not unique-person conversion rates/);
assert.match(report, /does not prove social-platform posting/);
assert.match(report, /No attribution proves/);
assert.doesNotMatch(report, /some-user-supplied-text|XX_USER_ID/);
assert.equal(summarizeSoundsFunnel([]).recordings.length, 0);
assert.throws(() => summarizeSoundsFunnel(Array(1501).fill({})), /row count/);
console.log("PASS: privacy-limited analytics SQL, sampled volume, per-station event ratios and per-recording aggregation.");
