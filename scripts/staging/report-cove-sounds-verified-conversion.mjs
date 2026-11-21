/* eslint-disable prettier/prettier -- Keep private aggregate reporting and SQL guards together. */
import assert from "node:assert/strict";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const database = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const dataset = "cove_sounds_funnel";
const stations = [
  "gothic-hour", "letters-never-sent", "beyond-the-old-woods",
  "rainlit-library", "the-long-voyage", "after-the-last-page",
];
const readOnly = (sql) => {
  assert.match(sql.trim(), /^(SELECT|WITH)\b/i);
  assert.doesNotMatch(sql, /;|\b(INSERT|UPDATE|DELETE|REPLACE|DROP|CREATE|ALTER|ATTACH|PRAGMA|VACUUM)\b/i);
  return sql;
};
const paidSql = readOnly(`
SELECT a.station_slug AS station,
       COUNT(*) AS paid_orders,
       SUM(CASE WHEN o.stripe_payment_intent_id IS NOT NULL
                 AND o.stripe_due_minor > 0 THEN 1 ELSE 0 END) AS stripe_paid_orders,
       SUM(CASE WHEN o.status='refunded' THEN 1 ELSE 0 END) AS fully_refunded_orders,
       SUM(CASE WHEN o.status='partially_refunded' THEN 1 ELSE 0 END) AS partly_refunded_orders
FROM commerce_sounds_purchase_attribution a
JOIN commerce_orders o ON o.id=a.order_id
WHERE o.status IN ('paid','partially_refunded','refunded')
  AND o.paid_at >= ?
GROUP BY a.station_slug ORDER BY a.station_slug
`);
const funnelSql = readOnly(`
SELECT blob2 AS station, blob3 AS event,
       SUM(_sample_interval) AS sampled_events
FROM ${dataset}
WHERE timestamp >= NOW() - INTERVAL '7' DAY
GROUP BY station,event LIMIT 200
`);
function render(paid, funnel, at) {
  const totals = new Map();
  for (const row of funnel) {
    if (!stations.includes(String(row.station))) continue;
    const key = String(row.station);
    const events = totals.get(key) || {};
    events[String(row.event)] = Math.max(0, Number(row.sampled_events) || 0);
    totals.set(key, events);
  }
  const receipts = new Map(paid.filter((x) => stations.includes(String(x.station)))
    .map((x) => [String(x.station), x]));
  const lines = [
    "# Cove Sounds · independently checked paid-order funnel",
    "",
    "Seven-day rolling window, evaluated " + at.toISOString() + ".",
    "",
    "| Station | Views (sample-weighted events) | Book opens | Reading observed | Paid orders (DB) | Stripe-backed | Fully refunded |",
    "|:--|--:|--:|--:|--:|--:|--:|",
  ];
  for (const station of stations) {
    const e = totals.get(station) || {}, p = receipts.get(station) || {};
    lines.push("| " + station + " | " + (e.station_view || 0) + " | " +
      (e.book_open || 0) + " | " + (e.reading_started || 0) + " | " +
      (p.paid_orders || 0) + " | " + (p.stripe_paid_orders || 0) +
      " | " + (p.fully_refunded_orders || 0) + " |");
  }
  lines.push("", "**Interpretation:** Paid-order counts are exact canonical checkout-order counts for a browser-declared Cove Sounds referral, including refunded orders (shown separately). Browser events are sampled/possibly repeated, opt-out-aware and do not identify unique visitors. Stripe-backed paid orders were settled by verified server-side commerce processing; a referral is not independently proven causal. No order IDs, user IDs, book IDs, amounts, IP addresses or browsing sessions leave this report. A/B or holdout evidence and nonzero real visitors are required before claiming conversion *lift*.");
  return lines.join("\n") + "\n";
}
// D1 uses the Cloudflare v4 success/result envelope. Analytics Engine SQL
// deliberately does not: its successful response is { data: [...], rows, ... }.
// Never confuse that valid no-envelope result with a rejected D1 query.
function decodeReportingResponse(value, contentType) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value),
    "Cloudflare reporting returned an invalid JSON object");
  if (contentType === "text/plain") {
    assert.ok(value.success !== false && Array.isArray(value.data),
      "Cloudflare Analytics Engine SQL rejected or malformed the result");
    return value;
  }
  assert.ok(value.success === true && Array.isArray(value.result),
    "Cloudflare D1 rejected or malformed the reporting result");
  return value.result;
}
// The scheduled aggregate reporter must never inherit a broad deploy token.
 // Cloudflare enforces D1 Read and Account Analytics Read independently.
 // No URL chosen by a caller can select arbitrary credential scopes.
function scopedReportingToken(path, contentType, variables = process.env) {
  const d1Path = "accounts/" + account + "/d1/database/" + database + "/query";
  const analyticsPath = "accounts/" + account + "/analytics_engine/sql";
  const token = path === d1Path && contentType === "application/json"
    ? variables.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN
    : path === analyticsPath && contentType === "text/plain"
      ? variables.COVE_CF_ANALYTICS_READ_TOKEN
      : null;
  assert.ok(typeof token === "string" && token.length >= 20,
    "A matching dedicated scoped Cloudflare reporting credential is required");
  return token;
}
async function cloudflare(path, { method = "GET", body, contentType = "application/json" } = {}) {
  assert.equal(method, "POST", "Reporting API must be a bounded POST read");
  const token = scopedReportingToken(path, contentType);
  const response = await fetch("https://api.cloudflare.com/client/v4/" + path, {
    method,
    headers: { authorization: "Bearer " + token, "content-type": contentType },
    body: body === undefined ? undefined : (contentType === "application/json" ? JSON.stringify(body) : body),
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, "Cloudflare reporting HTTP failure: " + response.status);
  const value = await response.json();
  return decodeReportingResponse(value, contentType);
}
if (process.argv.includes("--self-test")) {
  const output = render([{ station: "gothic-hour", paid_orders: 2, stripe_paid_orders: 1, fully_refunded_orders: 1 }],
    [{ station: "gothic-hour", event: "station_view", sampled_events: 5 }], new Date("2026-10-25T00:00:00Z"));
  assert.match(output, /gothic-hour \| 5 \| 0 \| 0 \| 2 \| 1 \| 1/);
  assert.ok(!output.includes("ord_"));
  assert.deepEqual(decodeReportingResponse({ success: true, result: [{ success: true, results: [] }] },
    "application/json"), [{ success: true, results: [] }]);
  assert.deepEqual(decodeReportingResponse({ data: [], rows: 0 }, "text/plain"),
    { data: [], rows: 0 });
  assert.throws(() => decodeReportingResponse({ success: false, errors: [] }, "text/plain"),
    /rejected or malformed/);
  assert.throws(() => decodeReportingResponse({ success: true, result: [] }, "text/plain"),
    /rejected or malformed/);
  assert.throws(() => decodeReportingResponse({ data: [] }, "application/json"),
    /rejected or malformed/);
  const scoped = {
    COVE_CF_PRODUCTION_AUDIT_READ_TOKEN: "D".repeat(32),
    COVE_CF_ANALYTICS_READ_TOKEN: "A".repeat(32),
    CLOUDFLARE_API_TOKEN: "UNSAFE_BROAD_TOKEN".repeat(3),
  };
  const d1Path = "accounts/" + account + "/d1/database/" + database + "/query";
  const analyticsPath = "accounts/" + account + "/analytics_engine/sql";
  assert.equal(scopedReportingToken(d1Path, "application/json", scoped), scoped.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN);
  assert.equal(scopedReportingToken(analyticsPath, "text/plain", scoped), scoped.COVE_CF_ANALYTICS_READ_TOKEN);
  assert.throws(() => scopedReportingToken(d1Path, "text/plain", scoped));
  assert.throws(() => scopedReportingToken(analyticsPath, "application/json", scoped));
  assert.throws(() => scopedReportingToken("accounts/" + account + "/tokens", "application/json", scoped));
  assert.throws(() => scopedReportingToken(d1Path, "application/json", { CLOUDFLARE_API_TOKEN: "W".repeat(32) }));
  assert.throws(() => scopedReportingToken(analyticsPath, "text/plain", { CLOUDFLARE_API_TOKEN: "W".repeat(32) }));
  console.log("PASS: read-only aggregate SQL, station allowlist and paid-order reporting");
} else {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [db, engine] = await Promise.all([
    cloudflare("accounts/" + account + "/d1/database/" + database + "/query",
      { method: "POST", body: { sql: paidSql, params: [since] } }),
    cloudflare("accounts/" + account + "/analytics_engine/sql",
      { method: "POST", contentType: "text/plain", body: funnelSql }),
  ]);
  assert.ok(db?.[0]?.success && Array.isArray(db[0].results), "Verified purchase SQL unavailable");
  assert.ok(Array.isArray(engine?.data), "Anonymous funnel SQL unavailable");
  const markdown = render(db[0].results, engine.data, new Date());
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
}
