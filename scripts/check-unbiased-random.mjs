import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/lib/unbiased-random.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const code = bundled.outputFiles[0].text;
const { unbiasedCryptoInt } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

for (const bound of [1, 2, 30, 10_000, 65_536, 0x1_0000_0000]) {
  const mask = 2 ** Math.ceil(Math.log2(bound)) - 1;
  const values = [0, bound - 1, mask === bound - 1 ? 0xffff_ffff : 0];
  for (const sample of values) {
    const result = unbiasedCryptoInt(bound, () => sample);
    assert.ok(Number.isInteger(result) && result >= 0 && result < bound);
  }
  if (mask >= bound) {
    let draws = 0;
    const expected = bound - 1;
    assert.equal(
      unbiasedCryptoInt(bound, () => {
        draws++;
        return draws === 1 ? mask : expected;
      }),
      expected,
      "Reject the high partial power-of-two bucket before accepting entropy",
    );
    assert.equal(draws, 2);
  }
}
for (const invalid of [0, -1, 1.25, Infinity, NaN, 0x1_0000_0001]) {
  assert.throws(() => unbiasedCryptoInt(invalid, () => 0), RangeError);
}
for (const invalid of [-1, NaN, 0x1_0000_0000, 0.5]) {
  assert.throws(() => unbiasedCryptoInt(30, () => invalid), RangeError);
}
const samples = Array.from({ length: 500 }, () => unbiasedCryptoInt(30));
assert.ok(samples.every((x) => x >= 0 && x < 30));
console.log("PASS: cryptographic retry jitter uses unbiased rejection sampling");
