import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Cloudflare's asset upload-session sometimes returns undocumented 10013.
// Only that exact provider error is retryable; any build, auth, permission,
// route, bundle or schema failure must stop immediately. All retries use the
// same reviewed bundle and staging-only Wrangler configuration.
export function transientAssetSessionFailure(output) {
  return /\/assets-upload-session\b/.test(output) && /\[code:\s*10013\]/.test(output);
}

if (process.argv.includes("--self-test")) {
  assert.equal(transientAssetSessionFailure(
    "A request to /workers/scripts/cove-storefront-ssr-staging/assets-upload-session failed. [code: 10013]"), true);
  for (const text of [
    "Workers deployment failed [code: 10013]",
    "/assets-upload-session rejected [code: 10000]",
    "Authentication error 403",
    "SyntaxError: invalid Worker",
  ]) assert.equal(transientAssetSessionFailure(text), false);
  console.log("PASS: retry only Cloudflare's transient asset upload-session 10013");
} else {
  const args = ["exec", "--yes", "--package=wrangler@4.151.0", "--",
    "wrangler", "deploy", "--config", "wrangler.frontend.staging.toml"];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = spawnSync("npm", args, {
      encoding: "utf8",
      timeout: 120_000,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status === 0 && !result.error) {
      // Print the normal Wrangler deployment evidence only on success.
      process.stdout.write(result.stdout || "");
      console.log("Cloudflare staging deployment succeeded on attempt " + attempt);
      break;
    }
    const output = String(result.stderr || "") + "\n" + String(result.stdout || "");
    if (attempt === 3 || !transientAssetSessionFailure(output)) {
      console.error("Cloudflare staging deployment failed; no non-10013 errors are retried.");
      // Preserve the exact exit status, never report a successful deploy.
      process.exitCode = 1;
      break;
    }
    console.warn("Transient Cloudflare asset upload-session 10013; bounded retry " +
      (attempt + 1) + "/3 on the identical protected staging artifact.");
    await new Promise((resolve) => setTimeout(resolve, attempt * 15_000));
  }
}
