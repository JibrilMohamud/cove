/** Return a uniform cryptographically secure integer in [0, exclusiveUpperBound).
 *
 * Masking to the smallest power-of-two bucket yields equally likely integers
 * in that bucket; rejecting those outside the requested bound preserves an
 * unbiased distribution. Neither modulo nor division is applied to entropy.
 *
 * Optional sample injection permits deterministic boundary testing. Production
 * callers must use the default Web Crypto provider.
 */
export function unbiasedCryptoInt(
  exclusiveUpperBound: number,
  nextUint32: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0],
): number {
  const range = 0x1_0000_0000;
  if (
    !Number.isSafeInteger(exclusiveUpperBound) ||
    exclusiveUpperBound < 1 ||
    exclusiveUpperBound > range
  )
    throw new RangeError("Invalid cryptographic jitter bound");
  const bits = Math.ceil(Math.log2(exclusiveUpperBound));
  const mask = 2 ** bits - 1;
  for (;;) {
    const sample = nextUint32();
    if (!Number.isInteger(sample) || sample < 0 || sample >= range)
      throw new RangeError("Invalid cryptographic random sample");
    const candidate = (sample & mask) >>> 0;
    if (candidate < exclusiveUpperBound) return candidate;
  }
}
