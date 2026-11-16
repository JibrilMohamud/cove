import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * A Git push is only a performance-certifiable deployment candidate when
 * automatic production builds are enabled. Manual and scheduled probes may
 * measure the currently pinned storefront but do not certify a newer main SHA.
 */
export function shouldRunProductionProbe(event, vercel) {
  if (event !== "push") return true;
  const enabled = vercel?.git?.deploymentEnabled;
  if (enabled === false) return false;
  if (enabled && typeof enabled === "object" && enabled.main === false) return false;
  return true;
}

function main() {
  const event = process.env.GITHUB_EVENT_NAME;
  if (!["push", "pull_request", "workflow_dispatch", "schedule"].includes(event)) {
    throw new Error("Unknown production performance workflow event");
  }
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  const shouldProbe = shouldRunProductionProbe(event, config);
  const output = process.env.GITHUB_OUTPUT;
  if (typeof output !== "string" || !output) {
    throw new Error("Missing GitHub Actions output file");
  }
  appendFileSync(output, `should_probe=${shouldProbe}\n`);
  if (!shouldProbe) {
    console.log(
      "SKIPPED: main Git deployment disabled; no new production SHA to measure. Release performance is NOT certified.",
    );
  } else if (event !== "push") {
    console.log(
      "Manual/scheduled probes measure the currently deployed storefront, not an unpromoted main commit.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
