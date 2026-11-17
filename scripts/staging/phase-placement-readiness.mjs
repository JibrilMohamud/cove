import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const READER = "cove-canonical-phase-readonly-staging";
const ALLOWED = new Set([
  "SUCCESS",
  "INSUFFICIENT_INVOCATIONS",
  "UNSUPPORTED_APPLICATION",
]);

// The API's service record reports whether Cloudflare has actually learned
// Smart Placement. An uploaded mode:smart config is never proof of optimization.
export function summarizePlacementReadiness(payload) {
  const script = payload?.default_environment?.script;
  assert.equal(script?.id, READER, "Unexpected Worker service");
  assert.equal(script?.placement_mode, "smart", "Isolated reader must use Smart Placement");
  assert.ok(script?.handlers?.includes("fetch"), "Reader fetch handler not deployed");
  const rawStatus = script.placement_status ?? script.placement?.status ?? null;
  assert.ok(rawStatus === null || ALLOWED.has(rawStatus), "Unknown placement state");
  return {
    schema: "cove.stage.placement-readiness.v1",
    status: rawStatus ?? "NOT_ANALYZED",
    optimized: rawStatus === "SUCCESS",
    releaseCertified: false,
  };
}

export async function inspectPlacementReadiness(token, request = fetch) {
  assert.ok(typeof token === "string" && token.length >= 20, "Read-only scope unavailable");
  const response = await request(
    "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT + "/workers/services/" + READER,
    {
      method: "GET",
      headers: { authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    },
  );
  assert.ok(response.ok, "Protected placement status read failed");
  const payload = await response.json();
  assert.equal(payload?.success, true, "Protected placement status unavailable");
  return summarizePlacementReadiness(payload.result);
}

if (process.argv[1]?.endsWith("phase-placement-readiness.mjs")) {
  inspectPlacementReadiness(process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN)
    .then((result) => {
      mkdirSync("artifacts", { recursive: true });
      writeFileSync(
        "artifacts/canonical-stage-placement-readiness.json",
        JSON.stringify(result, null, 2) + "\n",
      );
      // Only approved fixed status labels may enter a protected log.
      console.log(JSON.stringify(result));
    })
    .catch(() => {
      console.error("Protected Smart Placement readiness audit failed closed");
      process.exitCode = 1;
    });
}
