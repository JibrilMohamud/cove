import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";

const source = readFileSync("src/lib/primary-d1-overload.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { isPrimaryD1Overload } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

for (const error of [
  new Error("D1_ERROR: Too many requests to the same database. Code: 7429"),
  { message: "D1_ERROR: overload while reading" },
  { code: 7429 },
  { cause: { code: "7429" } },
]) {
  assert.equal(isPrimaryD1Overload(error), true);
}
for (const error of [
  new Error("Network unavailable"),
  new Error("HTTP 503 from upstream"),
  new Error("Rate limit exceeded 429"),
  { message: "An unrelated service overloaded" },
  { code: 503 },
  { cause: { code: "SQLITE_CONSTRAINT" } },
  "7429",
  null,
]) {
  assert.equal(isPrimaryD1Overload(error), false);
}

const operations = readFileSync("src/features/fore/operations.server.ts", "utf8");
const overload = operations.indexOf("if (isPrimaryD1Overload(error))");
const record = operations.indexOf("await db", overload);
assert.ok(overload >= 0 && record > overload);
const overloadedPath = operations.slice(overload, record);
assert.match(overloadedPath, /event: "primary_d1_overload"/);
assert.match(overloadedPath, /return;/);
assert.doesNotMatch(overloadedPath, /\.prepare\(|recordErrorEvent\(/);
const handler = readFileSync("src/features/fore/api.server.ts", "utf8");
assert.match(handler, /await recordErrorEvent\(env\.DB as any/);
assert.match(handler, /return json\(/);
console.log("Cloudflare D1 7429 skips recursive error writes; API still fails closed: PASS");
