import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  makeEvidence,
  summarizeD1Groups,
  summarizeD1QueryGroups,
  summarizeWorkerGroups,
  validatedWindow,
  verifyPinnedDeployment,
} from "./collect-protected-backend-503-graphql.mjs";

const VERSION = "401f2af2-6e69-4611-8110-1d127af6eecf";
const WINDOW = validatedWindow("2026-11-17T20:40:00Z", "2026-11-17T20:46:00Z");
const DEPLOYMENT = {
  result: {
    deployments: [
      {
        id: "9df84b20-0599-4fe9-a14e-2c11a4f25133",
        versions: [{ version_id: VERSION, percentage: 100 }],
      },
    ],
  },
};

function sample(minute, code, count, errors = 0, version = VERSION) {
  return {
    dimensions: {
      scriptVersion: version,
      datetimeMinute: minute,
      eventType: "fetch",
      httpResponseStatus: code,
    },
    sum: { requests: count, errors },
  };
}

function d1(minute, rowsRead, region = "ENAM") {
  return {
    dimensions: { datetimeMinute: minute, servedByRegion: region },
    sum: { readQueries: 25, writeQueries: 9, rowsRead, rowsWritten: 30 },
    avg: { queryBatchTimeMs: 250.0 },
  };
}

const DENSE_TAXONOMY_SQL = `WITH eligible AS MATERIALIZED (
 SELECT p.id FROM products p WHERE EXISTS (
 SELECT 1 FROM retail_product_availability rpa WHERE rpa.product_id=p.id
 )) SELECT et.taxonomy_node_id node_id,COUNT(*) product_count
 FROM eligible p JOIN edition_taxonomy_nodes et ON et.edition_id=p.id
 GROUP BY et.taxonomy_node_id
 -- Example literal that must never enter archived evidence: private@example.invalid
`;
function d1Query(
  minute,
  sqlText = DENSE_TAXONOMY_SQL,
  role = "primary",
  rowsRead = 13_613_128,
  region = "ENAM",
) {
  return {
    dimensions: {
      datetimeMinute: minute,
      query: sqlText,
      error: "",
      databaseRole: role,
      servedByRegion: region,
    },
    count: 8,
    sum: {
      rowsRead,
      rowsReturned: 280,
      rowsWritten: 0,
      queryDurationMs: 25_293.8248,
    },
  };
}

test("window requires exact UTC whole minutes and at most 20 minutes", () => {
  assert.deepEqual(WINDOW, {
    from: "2026-11-17T20:40:00Z",
    to: "2026-11-17T20:46:00Z",
  });
  for (const [from, to] of [
    ["2026-11-17T20:40:01Z", "2026-11-17T20:46:00Z"],
    ["2026-11-17T20:40:00+00:00", "2026-11-17T20:46:00Z"],
    ["2026-11-17T20:40:00Z", "2026-11-17T20:40:00Z"],
    ["2026-11-17T20:40:00Z", "2026-11-17T21:06:00Z"],
    ["2026-11-34T20:40:00Z", "2026-11-17T20:46:00Z"],
  ]) {
    assert.throws(() => validatedWindow(from, to));
  }
});

test("exact 100%-serving immutable backend version is mandatory", () => {
  const identity = verifyPinnedDeployment(DEPLOYMENT, VERSION);
  assert.equal(identity.version, VERSION);
  assert.equal(identity.deploymentId, DEPLOYMENT.result.deployments[0].id);
  assert.throws(() => verifyPinnedDeployment(DEPLOYMENT, "invalid"));
  assert.throws(() => verifyPinnedDeployment(DEPLOYMENT, "adc603f1-d82a-44d9-b302-509690dec5bd"));
  assert.throws(() =>
    verifyPinnedDeployment(
      {
        result: {
          deployments: [{ versions: [{ version_id: VERSION, percentage: 99 }] }],
        },
      },
      VERSION,
    ),
  );
  assert.throws(() =>
    verifyPinnedDeployment(
      {
        result: {
          deployments: [
            {
              versions: [
                { version_id: VERSION, percentage: 99 },
                { version_id: VERSION, percentage: 1 },
              ],
            },
          ],
        },
      },
      VERSION,
    ),
  );
});

test("reproduce 28 handled HTTP 503 and 14 HTTP 200 without calling D1", () => {
  const groups = [
    sample("2026-11-17T20:40:00Z", 503, 15),
    sample("2026-11-17T20:40:00Z", 200, 7),
    sample("2026-11-17T20:45:00Z", 503, 13),
    sample("2026-11-17T20:45:00Z", 200, 7),
    {
      dimensions: {
        scriptVersion: VERSION,
        datetimeMinute: "2026-11-17T20:45:00Z",
        eventType: "cron",
        httpResponseStatus: 0,
      },
      sum: { requests: 2, errors: 0 },
    },
  ];
  const results = summarizeWorkerGroups(groups, VERSION, WINDOW);
  assert.deepEqual(
    [results.fetchRequests, results.http503, results.http200, results.invocationErrors],
    [42, 28, 14, 0],
  );
  assert.deepEqual(
    results.perMinute.map((item) => item.http503),
    [15, 13],
  );
});

test("returning HTTP 503 is not confused with an uncaught Worker exception", () => {
  const results = summarizeWorkerGroups(
    [sample("2026-11-17T20:40:00Z", 503, 2, 0), sample("2026-11-17T20:40:00Z", 500, 1, 1)],
    VERSION,
    WINDOW,
  );
  assert.equal(results.http503, 2);
  assert.equal(results.invocationErrors, 1);
});

test("do not blend another backend version or out-of-window data", () => {
  assert.throws(() =>
    summarizeWorkerGroups(
      [sample("2026-11-17T20:45:00Z", 503, 1, 0, "adc603f1-d82a-44d9-b302-509690dec5bd")],
      VERSION,
      WINDOW,
    ),
  );
  assert.throws(() =>
    summarizeWorkerGroups([sample("2026-11-17T20:49:00Z", 503, 1)], VERSION, WINDOW),
  );
});

test("missing or truncated Worker metrics never certify zero failures", () => {
  assert.throws(() => summarizeWorkerGroups([], VERSION, WINDOW));
  assert.throws(() => summarizeWorkerGroups(undefined, VERSION, WINDOW));
  assert.throws(() =>
    summarizeWorkerGroups(Array(500).fill(sample("2026-11-17T20:45:00Z", 200, 1)), VERSION, WINDOW),
  );
});

test("invalid negative, fractional, and impossible response/status metrics fail", () => {
  for (const group of [
    sample("2026-11-17T20:40:00Z", 503, -1),
    sample("2026-11-17T20:40:00Z", 599.1, 1),
    sample("2026-11-17T20:40:00Z", 503, 1, 2),
  ]) {
    assert.throws(() => summarizeWorkerGroups([group], VERSION, WINDOW));
  }
});

test("D1 totals have no implicit HTTP request attribution", () => {
  const rows = summarizeD1Groups(
    [d1("2026-11-17T20:45:00Z", 1792545), d1("2026-11-17T20:40:00Z", 1794537)],
    WINDOW,
  );
  assert.equal(rows[0].rowsRead, 1794537);
  assert.equal(rows[1].rowsRead, 1792545);
  const report = makeEvidence({
    window: WINDOW,
    deployment: verifyPinnedDeployment(DEPLOYMENT, VERSION),
    workerRows: [sample("2026-11-17T20:45:00Z", 503, 13)],
    d1Rows: [d1("2026-11-17T20:45:00Z", 1792545)],
    d1QueryRows: [d1Query("2026-11-17T20:45:00Z")],
  });
  assert.equal(report.releaseCertified, false);
  assert.ok(report.limitations.some((s) => s.includes("not per-request")));
  assert.ok(report.limitations.some((s) => s.includes("before SQL execution")));
  assert.equal(report.worker.http503, 13);
  assert.equal(report.d1[0].readQueries, 25);
  assert.equal(report.queryHotspots.hotspots[0].queryClass, "taxonomy-count-distinct-view");
  assert.ok(!JSON.stringify(report).includes("private@example.invalid"));
  assert.ok(!JSON.stringify(report).includes("retail_product_availability"));
  assert.ok(!JSON.stringify(report).includes(DENSE_TAXONOMY_SQL));
  assert.ok(!JSON.stringify(report).includes("customerId"));
});

test("D1 region/metric validation refuses malformed provider data", () => {
  assert.throws(() => summarizeD1Groups([d1("2026-11-17T20:45:00Z", -1)], WINDOW));
  assert.throws(() => summarizeD1Groups([d1("2026-11-17T20:45:00Z", 1, "my-ip")], WINDOW));
  assert.throws(() => summarizeD1Groups(Array(500).fill(d1("2026-11-17T20:45:00Z", 1)), WINDOW));
});

test("classify primary taxonomy dense count without storing provider query text or errors", () => {
  const groups = summarizeD1QueryGroups(
    [
      d1Query("2026-11-17T20:45:00Z"),
      d1Query(
        "2026-11-17T20:44:00Z",
        DENSE_TAXONOMY_SQL.replace(
          "FROM retail_product_availability rpa",
          "FROM retail_product_availability_rows rpa",
        ),
        "replica",
        5_000,
      ),
      d1Query(
        "2026-11-17T20:43:00Z",
        "SELECT secret FROM request_logs WHERE user='private'",
        "primary",
        7,
      ),
    ],
    WINDOW,
  );
  assert.equal(groups.groupsObserved, 3);
  assert.deepEqual(
    groups.hotspots.map((x) => x.queryClass),
    ["taxonomy-count-distinct-view", "taxonomy-count-legal-rows", "unclassified"],
  );
  assert.equal(groups.hotspots[0].executions, 8);
  assert.equal(groups.hotspots[0].databaseRole, "primary");
  assert.equal(groups.hotspots[0].estimatedRowsRead, 13_613_128);
  assert.equal(groups.hotspots[0].estimatedSqlDurationMs, 25_293.8248);
  const serial = JSON.stringify(groups);
  for (const secret of [
    "private@example.invalid",
    "request_logs",
    "SELECT",
    "retail_product_availability",
  ])
    assert.ok(!serial.includes(secret), "Raw SQL must never leave the collector");
});

test("query insights preserve only an error flag, not D1 error details", () => {
  const failing = d1Query("2026-11-17T20:45:00Z");
  failing.dimensions.error = "unsafe sensitive query path: account_id=fixture-secret";
  const evidence = summarizeD1QueryGroups([failing], WINDOW);
  assert.equal(evidence.hotspots[0].hadSqlError, true);
  assert.ok(!JSON.stringify(evidence).includes("fixture-secret"));
  for (const malformed of [
    undefined,
    [],
    Array(500).fill(failing),
    [d1Query("2026-11-17T20:46:00Z")],
    [d1Query("2026-11-17T20:45:00Z", DENSE_TAXONOMY_SQL, "untrusted")],
    [d1Query("2026-11-17T20:45:00Z", DENSE_TAXONOMY_SQL, "primary", -1)],
    [d1Query("2026-11-17T20:45:00Z", DENSE_TAXONOMY_SQL, "primary", 1, "private region")],
  ])
    assert.throws(() => summarizeD1QueryGroups(malformed, WINDOW));
});

test("collector has no production SQL, Worker fetch or mutable Cloudflare endpoint", () => {
  const source = readFileSync("scripts/release/collect-protected-backend-503-graphql.mjs", "utf8");
  assert.doesNotMatch(source, /\/d1\/database\/|\/d1\/insights\/queries/);
  // Immutable deployment metadata GET is deliberately allowed; deployment
  // mutations, Worker version overrides and Worker URL fetches are not.
  assert.match(source, /"\/workers\/scripts\/" \+ WORKER \+ "\/deployments"/);
  assert.doesNotMatch(
    source,
    /\/workers\/scripts\/" \+ WORKER \+ "\/(?:deploy|versions|settings|secrets)"/,
  );
  assert.doesNotMatch(source, /"PUT"|"PATCH"|"DELETE"/);
  assert.match(source, /"POST" : "GET"/);
  assert.match(source, /workersInvocationsAdaptive/);
  assert.match(source, /d1AnalyticsAdaptiveGroups/);
  assert.match(source, /d1QueriesAdaptiveGroups/);
  assert.match(source, /summarizeD1QueryGroups/);
  assert.doesNotMatch(source, /query:\s*d\.query|error:\s*d\.error/);
  assert.doesNotMatch(source, /FORE_BACKEND_TOKEN|STRIPE_SECRET|AUTHORIZATION_SECRET/);
  assert.match(source, /releaseCertified: false/);
});
