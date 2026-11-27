import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { latestSecretDeploymentStatus } from "../cloudflare-deployment-readiness.mjs";

// Cold deployments use only the two ephemeral Workers. Never rotate a
// production/stable staging key or send an HTTP request to the serving edge.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(account, "d26430caa63ec55f6612e32f36aca5e9");
assert.ok(token && token.length > 20);
assert.ok(process.env.GITHUB_ENV, "Run only inside the isolated owned-canary workflow");
const configs = [
  ["wrangler.owned-authority.run.json", "cove-owned-homepage-authority"],
  ["wrangler.owned-application.run.json", "cove-asset-auth-stage"],
  ["wrangler.owned-homepage.run.json", "cove-owned-homepage-stage"],
  ["wrangler.owned-gateway.run.json", "cove-asset-auth-gateway"],
];
const secret = randomBytes(32).toString("hex");
const authorityKey = randomBytes(32).toString("hex");
console.log("::add-mask::" + authorityKey);
console.log("::add-mask::" + secret);
const rotated = Date.now();
for (const [config, name] of configs) {
  assert.equal(JSON.parse(fs.readFileSync(config, "utf8")).name, name);
  await new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      [
        "exec",
        "--yes",
        "--package=wrangler@4.151.0",
        "--",
        "wrangler",
        "secret",
        "put",
        name === "cove-owned-homepage-authority"
          ? "COVE_HOMEPAGE_AUTHORITY_KEY"
          : "COVE_SSR_STAGING_GATE_KEY",
        "--config",
        config,
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Ephemeral secret deployment failed")),
    );
    child.stdin.end(name === "cove-owned-homepage-authority" ? authorityKey : secret);
  });
  if (name === "cove-owned-homepage-stage") {
    await new Promise((resolve, reject) => {
      const child = spawn(
        "npm",
        [
          "exec",
          "--yes",
          "--package=wrangler@4.151.0",
          "--",
          "wrangler",
          "secret",
          "put",
          "COVE_HOMEPAGE_AUTHORITY_KEY",
          "--config",
          config,
        ],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Private authority rotation failed")),
      );
      child.stdin.end(authorityKey);
    });
  }
}
const deadline = Date.now() + 180_000;
let ready = false;
while (Date.now() < deadline) {
  const statuses = await Promise.all(
    configs.map(async ([, name]) => {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/deployments`,
        {
          headers: { authorization: "Bearer " + token },
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      assert.equal(response.ok, true, "Ephemeral deployment control-plane check failed");
      const payload = await response.json();
      assert.equal(payload.success, true);
      return latestSecretDeploymentStatus(payload, rotated, Date.now(), 75_000).ready;
    }),
  );
  if (statuses.every(Boolean)) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
assert.equal(ready, true, "Fresh 100% ephemeral deployments did not settle; refuse a cold claim");
fs.appendFileSync(
  process.env.GITHUB_ENV,
  `COVE_GATE_TEST_BEARER=${secret}\nCOVE_SSR_STAGING_GATE_KEY=${secret}\n`,
);
console.log(
  "PASS: all four ephemeral owned-canary deployments settled at 100%; no serving HTTP prewarm",
);
