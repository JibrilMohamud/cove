// Verify the already deployed, private typed-owner capture dependency. Never
// obtain its secret or overwrite it with the generic REST capture candidate.
import assert from "node:assert/strict";

const account = "d26430caa63ec55f6612e32f36aca5e9";
export const CAPTURE_NAME = "cove-pub-qa-continuous-capture";
export const CAPTURE_VERSION = "07fc397a-8234-4609-8f01-7c8ac4adf786";
export const CAPTURE_SOURCE = "1825b4a1-0329-408d-9cc2-a40e6a17c822";

export function requirePinnedCapture({ deployment, version, subdomain, schedules }) {
  assert.deepEqual(deployment?.deployments?.[0]?.versions, [
    { version_id: CAPTURE_VERSION, percentage: 100 },
  ]);
  assert.equal(version?.id, CAPTURE_VERSION);
  const bindings = version.resources?.bindings;
  assert.ok(Array.isArray(bindings));
  assert.equal(bindings.length, 4);
  const byName = new Map(bindings.map((b) => [b.name, b]));
  assert.equal(byName.size, 4);
  const db = byName.get("PUBLIC_SOURCE_DB");
  assert.equal(db?.type, "d1");
  assert.equal(db.id ?? db.database_id, CAPTURE_SOURCE);
  const reader = byName.get("SOURCE_READER");
  assert.equal(reader?.type, "service");
  assert.equal(reader.service, "cove-legal-authority-production");
  assert.equal(reader.entrypoint ?? null, null);
  assert.equal(byName.get("COVE_PUBLICATION_SOURCE_READER_SECRET")?.type, "secret_text");
  const enabled = byName.get("COVE_PUBLICATION_CAPTURE_ENABLED");
  assert.equal(enabled?.type, "plain_text");
  assert.equal(enabled.text, "1");
  assert.equal(subdomain?.enabled, false);
  assert.equal(subdomain?.previews_enabled, false);
  assert.deepEqual(
    schedules?.schedules?.map((s) => s.cron),
    ["* * * * *"],
  );
  return {
    worker: CAPTURE_NAME,
    version: CAPTURE_VERSION,
    source: CAPTURE_SOURCE,
    nativePrimaryBinding: false,
    typedOwnerReader: true,
    workersDevIngress: false,
    previewIngress: false,
  };
}

export async function verifyPinnedCapture(token, { fetchImpl = fetch } = {}) {
  assert.ok(typeof token === "string" && token.length >= 20);
  const root = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${CAPTURE_NAME}`;
  async function read(suffix) {
    const response = await fetchImpl(root + suffix, {
      method: "GET",
      headers: { authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json();
    assert.ok(
      response.ok && body.success === true,
      "Capture metadata unavailable: " + response.status,
    );
    return body.result;
  }
  const deployment = await read("/deployments");
  const version = await read("/versions/" + CAPTURE_VERSION);
  const subdomain = await read("/subdomain");
  const schedules = await read("/schedules");
  const evidence = requirePinnedCapture({ deployment, version, subdomain, schedules });
  assert.deepEqual(
    (await read("/deployments"))?.deployments?.[0]?.versions,
    deployment.deployments[0].versions,
  );
  return evidence;
}

export function freshCaptureCoverage(initial, rows, state, now) {
  return (
    Number.isSafeInteger(state?.expected) &&
    state.expected >= 1 &&
    state.expected <= 32 &&
    state.available === state.expected &&
    rows.length === state.expected &&
    new Set(rows.map((row) => row.country)).size === state.expected &&
    Number.isSafeInteger(state.last_synced) &&
    state.last_synced > now - 120000 &&
    state.last_synced <= now &&
    rows.every(
      (row) =>
        /^[A-Z]{2}$/.test(row.country) &&
        Number.isSafeInteger(row.generation) &&
        row.generation > (initial.get(row.country) ?? 0) &&
        Number.isSafeInteger(row.expires_at) &&
        row.expires_at > now,
    )
  );
}
