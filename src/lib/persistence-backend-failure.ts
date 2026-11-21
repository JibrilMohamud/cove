export type BackendFailureSource = "worker-api" | "worker-early" | "edge-or-runtime";

/** Only known backend-issued evidence is trusted for low-cardinality logs.
 * This classifier cannot authorize a fallback or expose response contents.
 */
export function backendFailureSource(headers: Headers): BackendFailureSource {
  const provenance = headers.get("x-cove-persistence");
  const cacheState = headers.get("x-cove-backend-cache");
  if (provenance !== "d1-r2" || !["HIT", "MISS", "BYPASS"].includes(cacheState || ""))
    return "edge-or-runtime";
  const phases = headers.get("server-timing") || "";
  return /(?:^|,)\s*cove_api;dur=\d+(?:\.\d+)?(?:,|$)/.test(phases) ? "worker-api" : "worker-early";
}

/** Only numeric phase presence is inspected. Never log the raw Server-Timing
 * header: it can include extensions that are not approved for public logs.
 */
export function backendFailurePhase(headers: Headers): "post-context" | "pre-context" | "untraced" {
  if (backendFailureSource(headers) !== "worker-api") return "untraced";
  const timing = headers.get("server-timing") || "";
  if (/(?:^|,)\s*cove_context;dur=\d+(?:\.\d+)?(?:,|$)/.test(timing)) return "post-context";
  if (/(?:^|,)\s*cove_auth;dur=\d+(?:\.\d+)?(?:,|$)/.test(timing)) return "pre-context";
  return "untraced";
}

/** An enum of failed timed stages, never an upstream exception message. */
export type BackendFailureStage =
  | "context"
  | "catalog"
  | "markets"
  | "limit"
  | "page"
  | "multiple"
  | "unknown"
  | "context-preference"
  | "context-market"
  | "context-locale"
  | "context-currency"
  | "context-details"
  | "pre-legal"
  | "pre-auth"
  | "pre-identity"
  | "pre-database";

export function backendFailureStage(headers: Headers): BackendFailureStage {
  if (backendFailureSource(headers) !== "worker-api") return "unknown";
  const timing = headers.get("server-timing") || "";
  const phases = ["context", "catalog", "markets", "limit", "page"] as const;
  const found = phases.filter((phase) =>
    new RegExp(`(?:^|,)\\s*cove_fault_${phase};dur=1(?:\\.0)?(?:,|$)`).test(timing),
  );
  const preStages = ["legal", "auth", "identity", "database"] as const;
  const pre = preStages.filter((stage) =>
    new RegExp(`(?:^|,)\\s*cove_fault_pre_${stage};dur=1(?:\\.0)?(?:,|$)`).test(timing),
  );
  if (found.length + pre.length > 1) return "multiple";
  if (pre.length === 1) return `pre-${pre[0]}`;
  if (found.length !== 1) return "unknown";
  // Hierarchical context detail is only trusted with the matching parent
  // failure marker and backend provenance. A child cannot override catalog,
  // admission or competing concurrent failure stages.
  if (found[0] !== "context") return found[0];
  const contextPhases = ["preference", "market", "locale", "currency", "details"] as const;
  const sub = contextPhases.filter((phase) =>
    new RegExp(`(?:^|,)\\s*cove_fault_context_${phase};dur=1(?:\\.0)?(?:,|$)`).test(timing),
  );
  return sub.length === 1 ? `context-${sub[0]}` : sub.length > 1 ? "multiple" : "context";
}

export type BackendFailureCategory =
  | "catalog-rights"
  | "market-configuration"
  | "locale-configuration"
  | "rate-limit"
  | "handler-exception"
  | "other";

/** Classification is read-only, never returned to the browser and cannot
 * authorize a fallback. Whitelisted exact messages only; no raw error,
 * request URLs, identity, cookies, response headers or secrets reach logs.
 */
const MAX_FAILURE_BODY_BYTES = 1024;
const FAILURE_READ_DEADLINE_MS = 150;

/**
 * The remote response is discarded on the production failure path. Consume
 * ONLY its first bounded JSON error document, without cloning a potentially
 * unbounded or stalled stream. Never let error categorization hold a customer
 * 503 for the upstream's 30-second fetch deadline.
 *
 * This intentionally consumes/cancels the response body. No caller may read
 * or forward the discarded upstream body after categorization.
 */
export async function backendFailureCategory(response: Response): Promise<BackendFailureCategory> {
  const lengthHeader = response.headers.get("content-length");
  if (
    response.status < 500 ||
    backendFailureSource(response.headers) !== "worker-api" ||
    !response.headers.get("content-type")?.includes("application/json") ||
    (lengthHeader !== null &&
      (!/^[0-9]+$/.test(lengthHeader) || Number(lengthHeader) > MAX_FAILURE_BODY_BYTES))
  )
    return "other";

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    if (!response.body) return "other";
    reader = response.body.getReader();
  } catch {
    return "other";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), FAILURE_READ_DEADLINE_MS);
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await Promise.race([
        reader.read().then(
          (value) => ({ kind: "read" as const, value }),
          () => ({ kind: "error" as const }),
        ),
        deadline,
      ]);
      if (next === "deadline" || next.kind === "error") return "other";
      if (next.value.done) break;
      const chunk = next.value.value;
      if (!(chunk instanceof Uint8Array)) return "other";
      total += chunk.byteLength;
      if (total > MAX_FAILURE_BODY_BYTES) return "other";
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return "other";
    const message = (value as { error?: unknown }).error;
    if (
      message === "The catalog is temporarily unavailable while Cove verifies distribution rights."
    )
      return "catalog-rights";
    if (message === "No active Cove storefront market is configured.")
      return "market-configuration";
    if (message === "This storefront has no active locale configured.")
      return "locale-configuration";
    if (
      message === "Unable to verify anonymous request for rate limiting." ||
      message === "Native storefront read limiter is unavailable." ||
      message === "Please wait a minute before trying again."
    )
      return "rate-limit";
    if (message === "This content could not be loaded. Please try again.")
      return "handler-exception";
  } catch {
    // Malformed, invalid UTF-8 or unreadable bytes cannot change deny behavior.
  } finally {
    if (timer) clearTimeout(timer);
    // Cancellation/cleanup must NEVER become another awaited upstream wait.
    // A pending reader.read is safely observed by the rejection handler above.
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A still-pending stream is discarded, never used for customer output.
    }
  }
  return "other";
}
