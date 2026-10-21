import assert from "node:assert/strict";

const origin = "https://cove-strangler-m1-staging.cove-jibrilmohamud.workers.dev";
const key = process.env.COVE_STRANGLER_STAGE_KEY || "";
assert.match(key, /^[a-f0-9]{64}$/);
const deadline = Date.now() + 390_000;
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
      if (data.stage === "bootstrap" && data.ok === true && data.books > 0) {
        console.log(
          "COVE_PRIVATE_MODEL_STAGE_READY: prepared candidates, primary rights, stage auth",
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
