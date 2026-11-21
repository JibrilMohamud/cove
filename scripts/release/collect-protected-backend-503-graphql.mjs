import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// An incident recorder, NOT a storefront acceptance or rights authority.
// It uses only Cloudflare analytics and Worker deployment metadata.
// In particular, it NEVER sends SQL to D1, invokes a Worker URL, or deploys.
const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const D1 = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const WORKER = "cove-persistence-backend";
const API = "https://api.cloudflare.com/client/v4";
const MAX_GROUPS = 500;

function finiteNonnegative(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid numeric analytics field: " + field);
  return value;
}

export function validatedWindow(from, to) {
  const exactMinute = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
  if (!exactMinute.test(from || "") || !exactMinute.test(to || ""))
    throw new Error("Audit window must use whole-minute UTC ISO timestamps.");
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    new Date(start).toISOString().replace(".000Z", "Z") !== from ||
    new Date(end).toISOString().replace(".000Z", "Z") !== to ||
    end - start < 60_000 ||
    end - start > 20 * 60_000
  )
    throw new Error("Audit interval must be valid and between 1 and 20 minutes.");
  return { from, to };
}

export function verifyPinnedDeployment(payload, expectedVersion) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(expectedVersion || ""))
    throw new Error("An exact immutable Worker version is required.");
  const active = payload?.result?.deployments?.[0];
  const versions = active?.versions;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0].version_id !== expectedVersion ||
    versions[0].percentage !== 100
  )
    throw new Error("Production deployment changed: aborting rather than mixing versions.");
  return { version: expectedVersion, deploymentId: active.id };
}

function safeMinute(value, from, to) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(value) ||
    value < from ||
    value >= to
  )
    throw new Error("Analytics returned an out-of-window minute.");
  return value;
}

export function summarizeWorkerGroups(rows, expectedVersion, window) {
  if (!Array.isArray(rows) || rows.length >= MAX_GROUPS)
    throw new Error("Worker analytics missing, truncated or over the row limit.");
  const byMinute = new Map();
  let fetchRequests = 0;
  let invocationErrors = 0;
  let http503 = 0;
  let http200 = 0;
  let fetchGroups = 0;
  for (const group of rows) {
    const d = group?.dimensions || {};
    if (d.scriptVersion !== expectedVersion)
      throw new Error("Historical Worker version differs from pinned serving version.");
    const minute = safeMinute(d.datetimeMinute, window.from, window.to);
    if (d.eventType !== "fetch") continue;
    fetchGroups += 1;
    const status = d.httpResponseStatus;
    if (!Number.isInteger(status) || status < 100 || status > 599)
      throw new Error("Invalid backend HTTP status.");
    const requests = finiteNonnegative(group.sum?.requests, "requests");
    const errors = finiteNonnegative(group.sum?.errors, "errors");
    if (errors > requests) throw new Error("Worker errors exceed invocations.");
    fetchRequests += requests;
    invocationErrors += errors;
    if (status === 503) http503 += requests;
    if (status === 200) http200 += requests;
    const prior = byMinute.get(minute) || {
      minute,
      fetchRequests: 0,
      http503: 0,
      http200: 0,
      invocationErrors: 0,
    };
    prior.fetchRequests += requests;
    if (status === 503) prior.http503 += requests;
    if (status === 200) prior.http200 += requests;
    prior.invocationErrors += errors;
    byMinute.set(minute, prior);
  }
  if (fetchGroups === 0 || fetchRequests === 0)
    throw new Error("No sampled backend HTTP invocations: no 503 verdict available.");
  return {
    fetchRequests,
    http503,
    http200,
    invocationErrors,
    perMinute: [...byMinute.values()].sort((a, b) => a.minute.localeCompare(b.minute)),
  };
}

export function summarizeD1Groups(rows, window) {
  if (!Array.isArray(rows) || rows.length >= MAX_GROUPS)
    throw new Error("D1 analytics missing, truncated or over the row limit.");
  return rows
    .map((group) => {
      const d = group?.dimensions || {};
      const region = d.servedByRegion;
      if (typeof region !== "string" || !/^[A-Z0-9-]{2,16}$/.test(region))
        throw new Error("Invalid D1 analytics region.");
      return {
        minute: safeMinute(d.datetimeMinute, window.from, window.to),
        region,
        readQueries: finiteNonnegative(group.sum?.readQueries, "readQueries"),
        writeQueries: finiteNonnegative(group.sum?.writeQueries, "writeQueries"),
        rowsRead: finiteNonnegative(group.sum?.rowsRead, "rowsRead"),
        rowsWritten: finiteNonnegative(group.sum?.rowsWritten, "rowsWritten"),
        meanSqlMs: finiteNonnegative(group.avg?.queryBatchTimeMs, "meanSqlMs"),
      };
    })
    .sort((a, b) => a.minute.localeCompare(b.minute) || a.region.localeCompare(b.region));
}

/**
 * D1 Insights can return captured SQL text, including literals in source SQL.
 * Inspect it in memory for an exact reviewed QUERY SHAPE only. No SQL string,
 * error body, source token or query hash may enter the written artifact.
 * Query-level adaptive sums may differ from per-database minute totals.
 */
export function summarizeD1QueryGroups(rows, window) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length >= MAX_GROUPS)
    throw new Error("D1 query insights missing or truncated; no root-cause verdict.");
  const groups = rows.map((group) => {
    const d = group?.dimensions || {};
    safeMinute(d.datetimeMinute, window.from, window.to);
    if (typeof d.query !== "string" || d.query.length > 32_768)
      throw new Error("Missing or unbounded D1 query classification input.");
    if (d.databaseRole !== "primary" && d.databaseRole !== "replica")
      throw new Error("Unexpected D1 serving role.");
    if (typeof d.servedByRegion !== "string" || !/^[A-Z0-9-]{2,16}$/.test(d.servedByRegion))
      throw new Error("Unexpected D1 query region.");
    const statement = d.query;
    const commonTaxonomy =
      statement.includes("WITH eligible AS MATERIALIZED") &&
      statement.includes("FROM eligible p JOIN edition_taxonomy_nodes et") &&
      statement.includes("COUNT(*) product_count") &&
      statement.includes("GROUP BY et.taxonomy_node_id");
    // An observed 82,247-row primary-D1 Insights SELECT matches this exact
    // *SQL shape*. It does NOT identify the Worker or job that submitted it.
    // In particular, the staging producer has a different D1 binding and no
    // active cron; do not misattribute a production query to that service.
    // Normalize ONLY in memory; never emit statement, binds or a query hash.
    const normalized = statement.replace(/\\s+/g, " ").trim().toLowerCase();
    const rankedCandidateScan =
      normalized.startsWith(
        "select d.product_id from catalog_search_documents d indexed by idx_search_popular_stable ",
      ) &&
      normalized.includes("join products p on p.id=d.product_id join editions e on e.id=p.edition_id") &&
      normalized.includes("from retail_product_availability_rows rpa") &&
      normalized.includes("rpa.product_id=p.id and rpa.territory_code=?") &&
      normalized.endsWith(
        "order by d.fore_bestseller_score desc,d.external_book_id asc,d.product_id asc limit ?",
      );
    const queryClass =
      commonTaxonomy && statement.includes("FROM retail_product_availability rpa")
        ? "taxonomy-count-distinct-view"
        : commonTaxonomy && statement.includes("FROM retail_product_availability_rows rpa")
          ? "taxonomy-count-legal-rows"
          : rankedCandidateScan
            ? "ranked-candidate-eligibility-scan"
            : "unclassified";
    const executions = finiteNonnegative(group.count, "query executions");
    const rowsRead = finiteNonnegative(group.sum?.rowsRead, "query rowsRead");
    const rowsWritten = finiteNonnegative(group.sum?.rowsWritten, "query rowsWritten");
    const rowsReturned = finiteNonnegative(group.sum?.rowsReturned, "query rowsReturned");
    const queryDurationMs = finiteNonnegative(group.sum?.queryDurationMs, "query duration");
    return {
      minute: d.datetimeMinute,
      queryClass,
      databaseRole: d.databaseRole,
      servedByRegion: d.servedByRegion,
      hadSqlError: Boolean(d.error),
      executions,
      estimatedRowsRead: rowsRead,
      estimatedRowsReturned: rowsReturned,
      estimatedRowsWritten: rowsWritten,
      estimatedSqlDurationMs: queryDurationMs,
    };
  });
  groups.sort((a, b) => b.estimatedRowsRead - a.estimatedRowsRead);
  return { groupsObserved: rows.length, hotspots: groups.slice(0, 10) };
}

export function makeEvidence({ window, deployment, workerRows, d1Rows, d1QueryRows }) {
  const worker = summarizeWorkerGroups(workerRows, deployment.version, window);
  const d1 = summarizeD1Groups(d1Rows, window);
  const queryHotspots = summarizeD1QueryGroups(d1QueryRows, window);
  return {
    schema: "cove.incident-773.graphql-readonly.v1",
    releaseCertified: false,
    scope: {
      fromUtc: window.from,
      toUtc: window.to,
      worker: WORKER,
      verifiedVersion: deployment.version,
      verifiedDeploymentId: deployment.deploymentId,
      database: "cove-production",
    },
    worker,
    d1,
    queryHotspots,
    limitations: [
      "Worker and D1 metrics are separate aggregates, not per-request correlations.",
      "A successful Worker invocation can return HTTP 503.",
      "D1 metrics omit requests rejected before SQL execution.",
      "D1 SQL time excludes queueing, dispatch, transport and client TTFB.",
      "Query-level insights use adaptive sampling; query totals need not equal D1 minute aggregates.",
      "The recorded query class is not raw SQL and is not an individual 503 attribution.",
      "A ranked-candidate SQL shape does not identify its invoking Worker, scheduled job or credential.",
      "No customer 503 root cause or release acceptance is established by this report.",
    ],
  };
}

// Only these four requests are permitted: one GET deployment metadata,
// and three POST GraphQL read-only analytics queries. No Worker ingress or D1 SQL.
async function fetchReadOnlyJson(path, token, graphqlQuery) {
  const url = API + path;
  const response = await fetch(url, {
    method: graphqlQuery ? "POST" : "GET",
    headers: {
      authorization: "Bearer " + token,
      ...(graphqlQuery ? { "content-type": "application/json" } : {}),
    },
    ...(graphqlQuery ? { body: JSON.stringify({ query: graphqlQuery }) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error("Cloudflare read-only endpoint unavailable; HTTP " + response.status);
  const json = await response.json();
  if (!json || json.success === false || (Array.isArray(json.errors) && json.errors.length))
    throw new Error("Cloudflare read-only endpoint returned an error.");
  return json;
}

function graphqlWorker(window) {
  return (
    'query { viewer { accounts(filter:{accountTag:"' +
    ACCOUNT +
    '"}) { workersInvocationsAdaptive(limit:500,filter:{datetime_geq:"' +
    window.from +
    '",datetime_lt:"' +
    window.to +
    '",scriptName:"' +
    WORKER +
    '"}) { dimensions{datetimeMinute scriptVersion httpResponseStatus eventType} sum{requests errors} } } } }'
  );
}

function graphqlD1(window) {
  return (
    'query { viewer { accounts(filter:{accountTag:"' +
    ACCOUNT +
    '"}) { d1AnalyticsAdaptiveGroups(limit:500,filter:{datetime_geq:"' +
    window.from +
    '",datetime_lt:"' +
    window.to +
    '",databaseId:"' +
    D1 +
    '"}) { dimensions{datetimeMinute servedByRegion} sum{readQueries writeQueries rowsRead rowsWritten} avg{queryBatchTimeMs} } } } }'
  );
}

function graphqlD1Queries(window) {
  return (
    'query { viewer { accounts(filter:{accountTag:"' +
    ACCOUNT +
    '"}) { d1QueriesAdaptiveGroups(limit:500,filter:{datetime_geq:"' +
    window.from +
    '",datetime_lt:"' +
    window.to +
    '",databaseId:"' +
    D1 +
    '"}) { dimensions{datetimeMinute query error databaseRole servedByRegion} count sum{rowsRead rowsReturned rowsWritten queryDurationMs} } } } }'
  );
}

async function collect() {
  if (process.env.COVE_GRAPHQL_READONLY_CONFIRM !== "1")
    throw new Error("Explicit protected read-only confirmation is required.");
  if (process.env.CF_ACCOUNT_ID !== ACCOUNT)
    throw new Error("Unexpected Cloudflare account; no cross-account audit.");
  const window = validatedWindow(
    process.env.COVE_GRAPHQL_WINDOW_FROM,
    process.env.COVE_GRAPHQL_WINDOW_TO,
  );
  const expected = process.env.COVE_EXPECTED_BACKEND_VERSION;
  const metadataToken = process.env.CF_WORKERS_METADATA_READ_TOKEN;
  const analyticsToken = process.env.CF_ANALYTICS_READ_TOKEN;
  if (!metadataToken || !analyticsToken)
    throw new Error(
      "Protected Workers Metadata Read and Account Analytics Read credentials are required.",
    );
  const metadata = await fetchReadOnlyJson(
    "/accounts/" + ACCOUNT + "/workers/scripts/" + WORKER + "/deployments",
    metadataToken,
  );
  const deployment = verifyPinnedDeployment(metadata, expected);
  const workerResult = await fetchReadOnlyJson("/graphql", analyticsToken, graphqlWorker(window));
  const d1Result = await fetchReadOnlyJson("/graphql", analyticsToken, graphqlD1(window));
  const d1QueryResult = await fetchReadOnlyJson(
    "/graphql",
    analyticsToken,
    graphqlD1Queries(window),
  );
  const workerRows = workerResult.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  const d1Rows = d1Result.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  const d1QueryRows = d1QueryResult.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups;
  const evidence = makeEvidence({ window, deployment, workerRows, d1Rows, d1QueryRows });
  const file = resolve("artifacts/incident-773/backend-graphql-evidence.json");
  await mkdir(resolve("artifacts/incident-773"), { recursive: true });
  await writeFile(file, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(
    JSON.stringify({
      schema: evidence.schema,
      fromUtc: window.from,
      toUtc: window.to,
      servingVersionVerified: true,
      backendHttp503: evidence.worker.http503,
      backendFetchRequests: evidence.worker.fetchRequests,
      backendInvocationErrors: evidence.worker.invocationErrors,
      d1RegionMinutes: evidence.d1.length,
      d1QueryGroups: evidence.queryHotspots.groupsObserved,
      releaseCertified: false,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  collect().catch(() => {
    // Deliberately do not print provider responses, URLs, queries or secrets.
    console.error("Protected Worker/D1 analytics collection failed closed; no release verdict.");
    process.exitCode = 1;
  });
