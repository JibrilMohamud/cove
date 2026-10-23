/** Fixed diagnostic vocabulary only: never log SQL, tokens, headers or user data. */
export function bootstrapFailureKind(error: unknown): string {
  const messages: string[] = [];
  let cause = error;
  for (let i = 0; i < 4 && cause instanceof Error; i++) {
    messages.push(cause.message);
    cause = cause.cause;
  }
  const message = messages.join(" ");
  if (/read limiter is unavailable/i.test(message)) return "limiter-unavailable";
  if (/presentation unavailable|missing candidate projection/i.test(message))
    return "presentation-absent";
  if (
    /invalid (?:presentation|display metadata|or expired private candidate projection)|unusable presentation snapshot/i.test(
      message,
    )
  )
    return "presentation-invalid";
  if (/private presentation binding required/i.test(message)) return "presentation-binding";
  if (/Please wait a minute/i.test(message)) return "rate-limited";
  if (/overloaded|too many requests|queue.*full/i.test(message)) return "service-overloaded";
  if (/reset|restart|disconnected|transient|network|temporarily unavailable/i.test(message))
    return "transient-service";
  if (/D1_|database|sqlite/i.test(message)) return "database";
  if (/country mismatch|territorial mismatch/i.test(message)) return "territory-mismatch";
  if (/market projection/i.test(message)) return "market-projection";
  return "unclassified";
}
