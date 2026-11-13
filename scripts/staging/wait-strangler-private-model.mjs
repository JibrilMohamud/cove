import assert from "node:assert/strict";

const origin = "https://cove-strangler-m1-staging.cove-jibrilmohamud.workers.dev";
const key = process.env.COVE_STRANGLER_STAGE_KEY || "";
assert.match(key, /^[a-f0-9]{64}$/);
// The private model has already been seeded; this checks real serving, not cron.
const deadline = Date.now() + 90_000;
let tries = 0;
while (Date.now() < deadline) {
  tries++;
  try {
    const response = await fetch(origin + "/__cove_perf/bootstrap", {
      headers: { authorization: "Bearer " + key },
      signal: AbortSignal.timeout(12000),
    });
    if (response.ok && response.headers.get("cache-control")?.includes("no-store")) {
      const data = await response.json();
      const timing = response.headers.get("server-timing") || "";
      // The old candidate-only model and the canonical fallback cannot emit
      // this v2-only presentation marker. Never certify an unmeasured model.
      const verifiedV2 = /(?:^|,\s*)cove_presentation;dur=[0-9]+(?:\.[0-9]+)?/.test(timing);
      if (data.stage === "bootstrap" && data.ok === true && data.books > 0 && verifiedV2) {
        console.log(
          "COVE_PRIVATE_MODEL_STAGE_READY: v2 R2/KV presentation, fresh primary rights, stage auth",
        );
        process.exit(0);
      }
    }
    if (tries % 6 === 1)
      console.log(
        "COVE_PRIVATE_MODEL_STAGE_PENDING " +
          JSON.stringify({
            status: response.status,
            failure: (response.headers.get("x-cove-stage-failure") || "unknown").slice(0, 32),
          }),
      );
  } catch (error) {
    if (tries % 6 === 1)
      console.log("COVE_PRIVATE_MODEL_STAGE_PENDING " + String(error?.name || "network"));
  }
  await new Promise((resolve) => setTimeout(resolve, 10000));
}
throw Error("No genuine protected private candidate response before deadline");
