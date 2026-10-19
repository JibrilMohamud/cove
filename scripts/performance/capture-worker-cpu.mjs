// Optional isolated CPU flamegraph capture, intentionally AFTER the measured
// cold/concurrency/LCP/attribution runs. It must never bias their latency data.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateHtml } from "../check-production-storefront-performance.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function profile(cohort, outputDir) {
  assert.match(cohort.name, /^cove-lazyfacet-(?:control|candidate)-staging$/);
  assert.match(cohort.key, /^[a-f0-9]{64}$/);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert.match(account || "", /^[a-f0-9]{32}$/);
  assert.ok(token?.trim(), "Scoped Cloudflare CI token required");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/${cohort.name}/versions/latest-deployed/profile`;
  const stageOrigin = `https://${cohort.name}.cove-jibrilmohamud.workers.dev`;
  const record = { worker: cohort.name, requested: 32, valid: 0, profileAvailable: false };
  const pending = fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ duration_ms: 10000, profile_type: "cpu" }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);
  await wait(400);
  // Bound profile-only requests to 32 after a fresh 65-second rate-limit
  // cool-off. No HTTP body, catalog details, IP, credential or URL is logged.
  for (let round = 0; round < 4; round++) {
    const settled = await Promise.all(
      Array.from({ length: 8 }, async () => {
        try {
          const response = await fetch(stageOrigin + "/", {
            headers: {
              Authorization: "Bearer " + cohort.key,
              Accept: "text/html",
              "Cache-Control": "no-store",
            },
            redirect: "manual",
            signal: AbortSignal.timeout(15000),
          });
          const html = await response.text();
          return (
            response.status === 200 &&
            validateHtml(response.status, response.headers.get("content-type") || "", html) > 0 &&
            /cove_ssr_local_rights;dur=0/.test(response.headers.get("server-timing") || "")
          );
        } catch {
          return false;
        }
      }),
    );
    record.valid += settled.filter(Boolean).length;
    await wait(150);
  }
  const response = await pending;
  if (!response || !response.ok) {
    record.warning = "Cloudflare profile capture unavailable";
    record.httpStatus = response?.status ?? 0;
    return record;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 80 || bytes.length > 32 * 1024 * 1024) {
    record.warning = "Cloudflare profile had unexpected length";
    return record;
  }
  // fetch auto-decompresses gzip; name file by detected wire payload bytes.
  const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const name = `latency-cpu-${cohort.name}.${compressed ? "pprof.gz" : "pprof"}`;
  fs.writeFileSync(path.join(outputDir, name), bytes);
  record.profileAvailable = true;
  record.file = name;
  record.bytes = bytes.length;
  return record;
}

export async function captureIsolatedCpuProfiles(cohorts, outputDir) {
  assert.equal(process.env.COVE_PAIR_RELEASE_FREEZE, "1");
  assert.equal(cohorts.baseline.sha, cohorts.current.sha);
  await wait(65000); // leave prior per-colo limiter window before profile-only work
  const records = [];
  for (const role of ["baseline", "current"]) {
    try {
      records.push(await profile(cohorts[role], outputDir));
    } catch {
      records.push({ role, profileAvailable: false, warning: "profile-capture-error" });
    }
  }
  return {
    isolatedOnly: true,
    timingNote:
      "Post-benchmark capture; sampled warm isolate CPU, not cold-start wall-time. Not part of SLO metrics.",
    profiles: records,
  };
}
