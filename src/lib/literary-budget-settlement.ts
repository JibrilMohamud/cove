/**
 * Refund pessimistic output *character-work* reservations only after a
 * successful profile has been validated and persisted to private R2.
 *
 * This is NOT a provider token-cost ledger: Cove's existing daily budget is
 * measured in estimated prompt/output character units. Retain pessimistic
 * reservations for failed, interrupted and unverified inferences.
 */
export function literaryOutputReservationRefund(
  promptCharacters: number,
  outputCharacters: number,
  reservedOutputCharacters: number,
) {
  if (![promptCharacters, outputCharacters, reservedOutputCharacters].every(Number.isSafeInteger))
    return 0;
  if (promptCharacters < 0 || outputCharacters < 0 || reservedOutputCharacters < 0) return 0;
  return Math.max(0, reservedOutputCharacters - outputCharacters);
}

export type LiteraryBudgetDB = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
    };
  };
};

/**
 * The caller MUST:
 * 1. Have successfully reserved full pessimistic units for this uncached call.
 * 2. Validate the actual response and publish a content-addressed R2 cache
 *    object BEFORE invoking this refund.
 * 3. Never invoke it for an R2 cache hit, including any retry after a crash.
 *
 * Thus retries cannot refund twice, and a crash before publication never
 * credits work that might have been incurred.
 */
export async function settleLiteraryOutputReservation(
  db: LiteraryBudgetDB,
  day: string,
  promptCharacters: number,
  outputCharacters: number,
  reservedOutputCharacters: number,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new Error("Invalid literary budget settlement day");
  const refunded = literaryOutputReservationRefund(
    promptCharacters,
    outputCharacters,
    reservedOutputCharacters,
  );
  if (refunded === 0) return { refunded: 0 };
  await db.prepare(
    "UPDATE literary_profile_budget SET reserved_units=MAX(0,reserved_units-?) WHERE day=?",
  ).bind(refunded, day).run();
  return { refunded };
}
