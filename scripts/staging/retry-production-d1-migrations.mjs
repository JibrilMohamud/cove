import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
export const productionD1 = "4bd657ac-8789-403e-a28c-93aba8d0a989";
export function isD1ResourceThrottle(message) {
  return typeof message === "string" &&
    (/D1 DB is overloaded/i.test(message) ||
      /Too many resources consumed within a 10 second window/i.test(message) ||
      /\bcode:\s*7429\b/i.test(message));
}
/** Wrangler D1 migrations have a durable migration journal: only retry the
 * exact rolling 10-second D1 resource rejection. Do not retry syntax errors,
 * rights migration validation, permission failures, or other API errors. */
export async function retryD1Migrations(
  operation,
  { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry = () => {} } = {},
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const outcome = await operation();
    if (outcome.exitCode === 0) return outcome;
    if (attempt === 3 || !isD1ResourceThrottle(outcome.output))
      throw new Error("D1 migrations aborted: " +
        (isD1ResourceThrottle(outcome.output) ? "D1 7429 persisted after bounded retry" : "non-transient failure"));
    const delay = 12_000 + attempt * 6_000;
    onRetry({ retry: attempt + 1, delayMs: delay });
    await sleep(delay);
  }
  throw new Error("Unreachable migration state");
}
function runWrangler() {
  const args = ["exec", "--yes", "--package=wrangler@4.151.0", "--",
    "wrangler", "d1", "migrations", "apply", "DB",
    "--remote", "--config", "wrangler.backend.deploy.toml"];
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, {
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(180_000),
    });
    let output = "";
    const append = (part) => { output = (output + part).slice(-100_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      exitCode: code ?? 1, signal, output,
    }));
  });
}
async function main() {
  assert.ok((process.env.CLOUDFLARE_API_TOKEN || "").length >= 10,
    "Cloudflare deployment credential unavailable");
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID,
    "d26430caa63ec55f6612e32f36aca5e9", "Wrong Cloudflare account");
  const config = readFileSync("wrangler.backend.deploy.toml","utf8");
  const id = process.env.D1_DATABASE_ID || productionD1;
  assert.equal(id, productionD1, "Production migration target must be canonical D1");
  assert.ok(config.includes('binding = "DB"') && config.includes('database_id = "' + id + '"'),
    "D1 migration binding must point at canonical DB");
  await retryD1Migrations(runWrangler, {
    onRetry: ({ retry, delayMs }) =>
      console.warn(JSON.stringify({ event:"cove_d1_7429_retry", retry, delayMs })),
  });
  console.log("Production D1 migrations applied or already up to date");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Production D1 migration failed");
    process.exitCode = 1;
  });
}
