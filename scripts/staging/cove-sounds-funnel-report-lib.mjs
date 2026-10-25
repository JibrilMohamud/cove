/* eslint-disable prettier/prettier -- Private bounded analytics aggregation and regression fixtures are kept together for auditability. */
const STATIONS = [
  "gothic-hour", "letters-never-sent", "beyond-the-old-woods",
  "rainlit-library", "the-long-voyage", "after-the-last-page",
];
const EVENTS = [
  "station_view", "music_open", "track_select", "book_open",
  "book_preview", "reading_intent", "reading_started", "purchase_intent",
  "purchase_observed", "share", "shelf_open", "shelf_create",
];
const FIELDS = ["station_view", "music_open", "track_select", "book_open",
  "book_preview", "reading_started", "purchase_observed", "share"];
export function buildSoundsFunnelSql(days = 7) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 30)
    throw new Error("Invalid aggregate reporting horizon");
  // No user, account, IP, query, page URL, book identifier or order identifier.
  return `SELECT blob2 AS station, blob3 AS event, blob4 AS recording,
    blob5 AS territory, sum(_sample_interval) AS estimated_events
    FROM cove_sounds_funnel
    WHERE timestamp >= NOW() - INTERVAL '${days}' DAY
      AND blob1 = 'cove-sounds-client-intent-v1'
    GROUP BY station, event, recording, territory
    ORDER BY station, event, recording, territory
    LIMIT 1500`;
}
function emptyMetrics() { return Object.fromEntries(EVENTS.map((key) => [key, 0])); }
export function summarizeSoundsFunnel(rows) {
  if (!Array.isArray(rows) || rows.length > 1500)
    throw new Error("Unexpected analytics row count");
  const stations = Object.fromEntries(STATIONS.map((station) => [station, emptyMetrics()]));
  const recordings = new Map();
  for (const record of rows) {
    if (!record || typeof record !== "object") continue;
    const { station, event, recording, territory } = record;
    if (!STATIONS.includes(station) || !EVENTS.includes(event) ||
        typeof territory !== "string" || !/^[A-Z]{2}$/.test(territory)) continue;
    const numeric = Number(record.estimated_events);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100_000_000) continue;
    stations[station][event] += numeric;
    if (typeof recording !== "string" || !/^(?:cm_[0-9]{1,15}|ex_[a-f0-9-]{36})$/.test(recording)) continue;
    const key = station + "|" + recording;
    const current = recordings.get(key) || { station, recording, ...emptyMetrics() };
    current[event] += numeric;
    recordings.set(key, current);
  }
  return {
    stations: STATIONS.map((station) => ({ station, ...stations[station] })),
    recordings: [...recordings.values()].sort(
      (a, b) =>
        (b.book_open + b.reading_started + b.purchase_observed + b.share) -
          (a.book_open + a.reading_started + a.purchase_observed + a.share) ||
        a.station.localeCompare(b.station) || a.recording.localeCompare(b.recording),
    ).slice(0, 20),
  };
}
const whole = (n) => Math.round(n).toLocaleString("en-US");
const exposure = (n, views) =>
  views > 0 ? (100 * n / views).toFixed(1) : "—";
export function renderSoundsFunnelMarkdown(summary, days) {
  const table = [
    "| Listening station | Views | Music opens | Book opens | Reader starts | Paid receipts observed | Share intents |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...summary.stations.map((x) =>
      `| ${x.station} | ${whole(x.station_view)} | ${whole(x.music_open)} | ${whole(x.book_open)} | ${whole(x.reading_started)} | ${whole(x.purchase_observed)} | ${whole(x.share)} |`,
    ),
  ];
  const rateTable = [
    "| Station | Music opens / 100 views | Book opens / 100 views | Reader starts / 100 views | Paid receipts observed / 100 views |",
    "|---|---:|---:|---:|---:|",
    ...summary.stations.map((x) =>
      `| ${x.station} | ${exposure(x.music_open, x.station_view)} | ${exposure(x.book_open, x.station_view)} | ${exposure(x.reading_started, x.station_view)} | ${exposure(x.purchase_observed, x.station_view)} |`,
    ),
  ];
  const trackTable = summary.recordings.length
    ? [
      "| Station | Master ID | Selections | Book opens | Reader starts | Paid receipts observed | Shares |",
      "|---|---|---:|---:|---:|---:|---:|",
      ...summary.recordings.map((x) =>
        `| ${x.station} | ${x.recording} | ${whole(x.track_select)} | ${whole(x.book_open)} | ${whole(x.reading_started)} | ${whole(x.purchase_observed)} | ${whole(x.share)} |`,
      ),
    ]
    : ["No track-specific observations have been reported yet."];
  return [
    `## Cove Sounds discovery funnel — last ${days} days`,
    "",
    "Aggregate Analytics Engine events only. This report contains no member, book, order or IP identifiers.",
    "",
    "### Station event counts",
    ...table,
    "",
    "### Descriptive activity per 100 station views",
    ...rateTable,
    "",
    "### Track-linked observations",
    ...trackTable,
    "",
    "**Measurement boundaries:** These are event ratios, not unique-person conversion rates or causal purchase lift. A station visitor can generate repeated events; privacy opt-outs are excluded; Analytics Engine may sample high-volume traffic. A reader start means the reader reached a ready state, not five minutes read. A paid receipt is a client-observed authorized order status, not a newly verified signed webhook. A share intent does not prove social-platform posting. A recording is included only when the session actually retained a valid track ID. No attribution proves that a specific recording caused a purchase.",
    "",
  ].join("\n");
}
