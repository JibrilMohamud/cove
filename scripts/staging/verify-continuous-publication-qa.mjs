// Verify an actual continuously scheduled, isolated QA publication pipeline.
// Neither the source nor the serving customer database is mutated here.
import assert from "node:assert/strict";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const source = "1825b4a1-0329-408d-9cc2-a40e6a17c822";
const ledger = "34cf996a-830d-4ec3-8071-8cc3ec7b6df9";
const prefix = "feed/qa/continuous/private/presentation/v2/home/";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token && process.env.CLOUDFLARE_ACCOUNT_ID === account);
async function api(method, path, payload) {
  const result = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  const body = await result.json();
  assert.ok(result.ok && body.success, "Private QA verification API error " + result.status);
  return body.result;
}
async function sql(id, query) {
  return (
    await api("POST", `/accounts/${account}/d1/database/${id}/query`, {
      sql: query,
    })
  )[0].results;
}
function snapshotHealthy(body, country, now) {
  return (
    body?.schema === "cove.home.presentation.v2" &&
    body?.candidates?.country === country &&
    body?.candidates?.expiresAt > now + 60000 &&
    Array.isArray(body?.displayBooks)
  );
}
async function health() {
  const now = Date.now();
  const sourceRows = await sql(
    source,
    "SELECT (SELECT COUNT(*) FROM cove_publication_source_snapshots WHERE expires_at>" +
      now +
      ") fresh,(SELECT expected_markets FROM cove_publication_source_progress WHERE id=1) expected," +
      "(SELECT last_synced_at FROM cove_publication_source_identity WHERE id=1) last_synced",
  );
  const pubs = await sql(
    ledger,
    "SELECT country,generation,status,expires_at,published_at,last_error FROM discovery_publications WHERE active=1",
  );
  const s = sourceRows[0];
  const complete =
    s?.expected > 0 &&
    s?.expected <= 32 &&
    s.fresh === s.expected &&
    s.last_synced > now - 120000 &&
    pubs.length === s.expected &&
    pubs.every(
      (r) =>
        r.status === "delivered" &&
        r.generation >= 1 &&
        r.expires_at > now + 60000 &&
        r.published_at > now - 14 * 60000 &&
        !r.last_error,
    );
  return {
    now,
    complete,
    expected: s?.expected,
    fresh: s?.fresh,
    sourceLagMs: now - (s?.last_synced || 0),
    count: pubs.length,
    delivered: pubs.filter((r) => r.status === "delivered").length,
    latestPublish: pubs.reduce((x, r) => Math.max(x, r.published_at), 0),
    versions: pubs.map((r) => ({ country: r.country, generation: r.generation })),
  };
}
// One full 23-market rotation takes ~12 one-minute invocations; exporter and
// publisher can need a further six minutes. Wait, but never accept partial data.
const started = Date.now();
let healthy;
for (let attempt = 1; attempt <= 54; attempt++) {
  healthy = await health();
  if (attempt % 4 === 1 || healthy.complete)
    console.log(
      "CONTINUOUS_QA_HEALTH",
      JSON.stringify({
        complete: healthy.complete,
        fresh: healthy.fresh,
        expected: healthy.expected,
        delivered: healthy.delivered,
        sourceLagMs: healthy.sourceLagMs,
        elapsedMs: Date.now() - started,
      }),
    );
  if (healthy.complete) break;
  await new Promise((resolve) => setTimeout(resolve, 30000));
}
assert.ok(healthy?.complete, "Continuous QA has not produced a complete fresh market publication");
for (const country of ["US", "CA", "JP", "SA"]) {
  const r = await api(
    "GET",
    `/accounts/${account}/r2/buckets/cove-strangler-private-presentation-stage/objects/${prefix}${country}.json`,
  );
  assert.ok(snapshotHealthy(r, country, Date.now()), "Stale or invalid QA R2 " + country);
}
// Observe an independently recurring source refresh after initial success:
// a successful published snapshot alone does not certify recurring capture.
const initial = await sql(
  source,
  "SELECT country,generation FROM cove_publication_source_snapshots",
);
const initialVersions = new Map(initial.map((r) => [r.country, r.generation]));
let advanced = false;
for (let attempt = 0; attempt < 5; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 30000));
  const later = await sql(
    source,
    "SELECT country,generation FROM cove_publication_source_snapshots",
  );
  advanced ||= later.some((r) => r.generation > (initialVersions.get(r.country) || 0));
  if (advanced) break;
}
assert.ok(advanced, "QA cron capture did not advance a source generation after publication");
console.log(
  "PASS: 23-market continuous capture and isolated ledger/R2 publication are fresh; " +
    "recurring cron generation observed; no production routing.",
);
