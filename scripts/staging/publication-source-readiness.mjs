import assert from "node:assert/strict";
import { freshCaptureCoverage } from "./verify-pinned-publication-capture.mjs";

// Deployment can consume the freshness receipt obtained during backfill.
// Prepare immediately before each export using only the independent source's
// read-only control plane. Leave the runtime's 120-second guard unchanged.
export async function preparePublicationExport({
  initial,
  read,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  assert.ok(initial instanceof Map && typeof read === "function");
  const deadline = now() + 180000;
  for (let attempt = 1; attempt <= 90 && now() < deadline; attempt++) {
    const { rows, state } = await read();
    const checked = now();
    const age = checked - state?.last_synced;
    if (freshCaptureCoverage(initial, rows, state, checked) && age >= 0 && age <= 30000)
      return { attempts: attempt, markets: state.expected, sourceAgeMs: age };
    if (attempt < 90 && now() < deadline) await sleep(2000);
  }
  throw Error("Independent source did not provide fresh complete export preparation");
}
