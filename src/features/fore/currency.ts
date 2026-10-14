/** Monetary amounts are stored as ISO 4217 minor units, not cents.
 * Intl supplies the currency's CLDR fraction digits (JPY/KRW = 0, KWD = 3).
 * Never format or round an integer minor-unit price before payment.
 */
export function currencyMinorUnitDigits(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("Invalid ISO currency code.");
  return (
    new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}
export function minorUnitsToMajor(amountMinor: number, currency: string): number {
  if (!Number.isSafeInteger(amountMinor))
    throw new Error("Monetary minor units must be a safe integer.");
  return amountMinor / 10 ** currencyMinorUnitDigits(currency);
}
export function formatMinorCurrency(
  amountMinor: number,
  currency: string,
  locale = "en-US",
): string {
  const major = minorUnitsToMajor(amountMinor, currency);
  const code = currency.trim().toUpperCase();
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: code }).format(major);
  } catch {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(major);
  }
}
