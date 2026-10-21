import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-load-failures-"));
const entry = pathToFileURL(path.resolve("scripts/staging/check-commercial-parity-rps.mjs")).href;
try {
  // Exercise the real pacing, validation, gate and artifact writer without
  // credentials or external traffic. Three fast HTTP-200 failures must not
  // disappear behind the slowest successful responses.
  const driver = path.join(root, "driver.mjs");
  fs.writeFileSync(
    driver,
    `
    let homeCalls = 0;
    globalThis.fetch = async (url) => {
      const route = new URL(url).pathname;
      const headers = {
        "content-type": route === "/" ? "text/html" : "application/json",
        "cache-control": "no-store",
        "x-cove-stage-context-mode": "one-read",
        "x-cove-stage-bootstrap-transport": "primary-batch",
        "server-timing": "cove_ssr_local_rights;dur=0",
      };
      let body;
      let failure = false;
      if (route === "/") {
        homeCalls++;
        body = '<article class="book-card"></article>';
        if (homeCalls === 35) { body = "<main>Unavailable</main>"; failure = true; }
        if (homeCalls === 50) { delete headers["server-timing"]; failure = true; }
        if (homeCalls === 65) { headers["x-cove-stage-bootstrap-transport"] = "individual"; failure = true; }
      } else if (route.endsWith("/bootstrap")) {
        body = JSON.stringify({context:{rightsCountry:"US"},catalog:{results:[{productId:"p_stage_fixture"}]}});
      } else {
        body = JSON.stringify({results:[{productId:"p_stage_fixture"}]});
      }
      if (!failure) await new Promise(resolve => setTimeout(resolve, 8));
      return new Response(body, {status:200,headers});
    };
    await import(${JSON.stringify(entry)});
  `,
  );
  const run = spawnSync(process.execPath, [driver], {
    cwd: root,
    env: {
      ...process.env,
      COVE_STAGE_HTTP2: "0",
      COVE_STAGE_EXPERIMENT_ARM: "one-read",
      COVE_SSR_STAGING_GATE_KEY: "a".repeat(64),
    },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(
    fs.readFileSync(
      path.join(root, "artifacts/commercial-parity-mixed-rps-native-fetch.json"),
      "utf8",
    ),
  );
  assert.equal(report.stages.length, 1, "Invalid delivery stops load escalation");
  const stage = report.stages[0];
  assert.equal(stage.delivered, 125);
  assert.equal(stage.valid, 122);
  assert.equal(stage.failed, 3);
  assert.equal(stage.failedResponses.length, 3, "Retain every invalid response");
  assert.equal(stage.statusCounts["200"], 125, "HTTP 200 alone never establishes validity");
  assert.equal(stage.pass, false);
  assert.deepEqual(stage.failedResponses.flatMap((row) => row.failureReasons).sort(), [
    "bootstrap-transport",
    "invalid-html",
    "live-rights-timing",
  ]);
  assert.equal(
    stage.slowest.some((row) => !row.valid),
    false,
    "Failures were outside slowest samples",
  );
  for (const row of stage.failedResponses) {
    assert.equal("body" in row, false);
    assert.equal("headers" in row, false);
  }
  console.log(
    "PASS: fast invalid HTTP-200 responses retained with reasons; hard gate and escalation preserved.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
