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

const handler = readFileSync("src/features/fore/api.server.ts", "utf8");
const overload = handler.indexOf("if (isPrimaryD1Overload(e))");
const other = handler.indexOf("} else {", overload);
const record = handler.indexOf("await recordErrorEvent(", overload);
assert.ok(overload >= 0 && other > overload && record > other);
assert.ok(handler.slice(overload, other).includes("execution?.waitUntil"));
assert.ok(handler.slice(overload, other).includes("reportExternalError"));
assert.doesNotMatch(handler.slice(overload, other), /recordErrorEvent\(/);
assert.match(handler.slice(record), /return json\(/);
console.log("Cloudflare D1 7429 skips recursive error writes; API still fails closed: PASS");
