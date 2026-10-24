/**
 * Return pessimistically reserved *character-work*, not provider spend.
 * The inference must have been validated and stored in private R2 first.
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

type SettlementStatement = {
  bind(...values: unknown[]): SettlementStatement;
  run(): Promise<unknown>;
};

export type LiteraryBudgetDB = {
  prepare(sql: string): SettlementStatement;
  batch(statements: SettlementStatement[]): Promise<unknown>;
};

/**
 * Exactly-once, even across simultaneous workers or a D1 retry:
 * INSERT receipt + conditional daily-budget UPDATE + mark receipt applied
 * execute atomically in ONE D1 batch. A successful batch either records the
 * unique cache key and one refund, or records no refund at all.
 *
 * Called only for a newly generated, verified, successfully persisted R2
 * response, never for a cache hit. A transient failure leaves full units
 * conservatively reserved. The deterministic receipt key is the canonical
 * content-addressed R2 cache key, NOT a random job/lease identifier.
 */
export async function settleLiteraryOutputReservation(
  db: LiteraryBudgetDB,
  day: string,
  promptCharacters: number,
  outputCharacters: number,
  reservedOutputCharacters: number,
  receiptKey: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid literary budget settlement day");
  if (!/^literary\/inference\/[a-zA-Z0-9_.:-]+\/[0-9a-f]{64}\.json$/.test(receiptKey))
    throw new Error("Invalid literary settlement receipt key");
  const refunded = literaryOutputReservationRefund(
    promptCharacters,
    outputCharacters,
    reservedOutputCharacters,
  );
  if (refunded === 0) return { refunded: 0 };
  // One transaction controls the deduplication receipt and its accounting.
  const insert = db
    .prepare(
      "INSERT OR IGNORE INTO literary_output_settlement_receipts" +
        " (receipt_key,day,refund_units,applied)" +
        " SELECT ?,?,?,0 WHERE EXISTS" +
        " (SELECT 1 FROM literary_profile_budget WHERE day=?)",
    )
    .bind(receiptKey, day, refunded, day);
  const decrement = db
    .prepare(
      "UPDATE literary_profile_budget SET reserved_units=MAX(0,reserved_units-?)" +
        " WHERE day=? AND EXISTS(SELECT 1 FROM literary_output_settlement_receipts" +
        " WHERE receipt_key=? AND day=? AND refund_units=? AND applied=0)",
    )
    .bind(refunded, day, receiptKey, day, refunded);
  const finalize = db
    .prepare(
      "UPDATE literary_output_settlement_receipts SET applied=1" +
        " WHERE receipt_key=? AND day=? AND refund_units=? AND applied=0" +
        " AND EXISTS(SELECT 1 FROM literary_profile_budget WHERE day=?)",
    )
    .bind(receiptKey, day, refunded, day);
  const results = (await db.batch([insert, decrement, finalize])) as Array<{
    meta?: { changes?: number };
  }>;
  const credited = Number(results[1]?.meta?.changes || 0) === 1;
  return { refunded: credited ? refunded : 0 };
}
