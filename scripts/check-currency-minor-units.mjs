import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-currency-"));
try {
  const outfile = path.join(dir, "currency.mjs");
  await build({
    entryPoints: ["src/features/fore/currency.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { formatMinorCurrency, minorUnitsToMajor, currencyMinorUnitDigits } = await import(outfile);
  assert.equal(currencyMinorUnitDigits("USD"), 2);
  assert.equal(currencyMinorUnitDigits("JPY"), 0);
  assert.equal(currencyMinorUnitDigits("KRW"), 0);
  assert.equal(currencyMinorUnitDigits("KWD"), 3);
  assert.equal(minorUnitsToMajor(1234, "USD"), 12.34);
  assert.equal(minorUnitsToMajor(1234, "JPY"), 1234);
  assert.equal(minorUnitsToMajor(1234, "KRW"), 1234);
  assert.equal(minorUnitsToMajor(1234, "KWD"), 1.234);
  assert.equal(formatMinorCurrency(1234, "JPY", "ja-JP"), "￥1,234");
  assert.ok(formatMinorCurrency(1234, "KRW", "ko-KR").includes("1,234"));
  assert.ok(formatMinorCurrency(1234, "KWD", "en-KW").includes("1.234"));
  assert.throws(() => minorUnitsToMajor(1.5, "USD"), /safe integer/);
  assert.throws(() => minorUnitsToMajor(Number.MAX_SAFE_INTEGER + 1, "USD"), /safe integer/);
  console.log("PASS: ISO minor units JPY/KRW (0), USD (2), KWD (3), locale and integer safety");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
