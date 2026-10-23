/** Return an unbiased cryptographic integer in [0, exclusiveUpperBound).
 * Each 32-bit sample is uniformly distributed. The largest partial interval
 * is rejected before converting the sample to a bounded index, so the final
 * distribution remains uniform even when 2^32 is not divisible by the bound.
 *
 * An optional sample provider permits deterministic rejection-boundary tests.
 * Production callers must use the default Web Crypto provider.
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
  const limit = Math.floor(range / exclusiveUpperBound) * exclusiveUpperBound;
  for (;;) {
    const sample = nextUint32();
    if (!Number.isInteger(sample) || sample < 0 || sample >= range)
      throw new RangeError("Invalid cryptographic random sample");
    if (sample < limit)
      return sample - Math.floor(sample / exclusiveUpperBound) * exclusiveUpperBound;
  }
}
