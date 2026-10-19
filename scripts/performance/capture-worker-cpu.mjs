// Optional isolated CPU flamegraph capture, intentionally AFTER the measured
// cold/concurrency/LCP/attribution runs. It must never bias their latency data.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  // Cloudflare profiles an already-loaded isolate. The 65-second quiet window
  // used for rate limiting may have evicted it. Warm only after *all* TTFB
  // and LCP samples are saved; enforce the same live-rights HTML invariant.
  let warmed = false;
  try {
    const ready = await fetch(stageOrigin + "/", {
      headers: {
        Authorization: "Bearer " + cohort.key,
        Accept: "text/html",
        "Cache-Control": "no-store",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const html = await ready.text();
    warmed =
      ready.status === 200 &&
      validateHtml(ready.status, ready.headers.get("content-type") || "", html) > 0 &&
      /cove_ssr_local_rights;dur=0/.test(ready.headers.get("server-timing") || "");
  } catch {
    // A warm-up failure is recorded; do not fetch a profile of unknown traffic.
  }
  if (!warmed) {
    record.warning = "Rights-authorized CPU profile warm-up unavailable";
    return record;
  }
  record.warmupRightsValid = true;
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
    // Keep real homepage CPU work distributed through the capture window;
    // a single initial burst may produce an idle-only 10-second pprof.
    await wait(1500);
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
  record.validProfileTraffic = record.valid === record.requested;
  if (!record.validProfileTraffic)
    record.warning = "CPU capture includes failed or invalid synthetic HTML; no causal attribution";
  // pprof is supplemental: the binary remains useful if Go tooling is absent
  // or the Cloudflare capture uses an unsupported protobuf profile format.
  const top = spawnSync(
    "go",
    ["tool", "pprof", "-top", "-nodecount=20", path.join(outputDir, name)],
    {
      timeout: 30000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  if (!top.error && top.status === 0 && top.stdout.trim()) {
    const summaryName = `latency-cpu-top-${cohort.name}.txt`;
    fs.writeFileSync(path.join(outputDir, summaryName), top.stdout.slice(0, 24000));
    record.topFile = summaryName;
    // A Cloudflare API 200 can return a tiny, parseable pprof containing
    // only (root)/(idle). An idle profile is NOT evidence that SSR uses no CPU.
    const sampledFunctions = top.stdout
      .split("\\n")
      .filter((line) => /^\\s*[\\d.]+(?:ns|us|ms|s)\\s+/.test(line))
      .filter((line) => !/\\((?:idle|root)\\)\\s*$/.test(line));
    record.profileUsable = record.validProfileTraffic && sampledFunctions.length > 0;
    if (!record.profileUsable)
      record.topWarning = "CPU profile is idle-only or lacks representative rights-valid samples";
  } else {
    record.profileUsable = false;
    record.topWarning = "pprof text conversion unavailable; binary profile retained";
  }
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
