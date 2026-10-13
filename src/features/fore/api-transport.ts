export class CoveRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public requestId: string | null,
    public retryable: boolean,
    public retryAfterSeconds: number | null = null,
    public mutationUncertain = false,
  ) {
    super(message);
    this.name = "CoveRequestError";
  }
}
export type RequestOptions = { signal?: AbortSignal; timeoutMs?: number; retryReads?: boolean };
const retryStatuses = new Set([429, 502, 503, 504]);
function retryDelay(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 86400);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(86400, Math.max(0, (date - Date.now()) / 1000)) : null;
}

/** Replay only reads. Mutations may have completed even if their reply was
 * lost; callers must use their domain's idempotency key before retrying.
 */
export async function requestCove<T>(
  path: string,
  method = "GET",
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const read = ["GET", "HEAD"].includes(method.toUpperCase());
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs ?? (read ? 25000 : 45000));
    let failure: CoveRequestError;
    try {
      const response = await fetch("/api/fore" + path, {
        method,
        credentials: "same-origin",
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const reference = response.headers.get("x-fore-request-id");
      const requestId = reference && /^[a-zA-Z0-9_-]{1,100}$/.test(reference) ? reference : null;
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new CoveRequestError(
          "Cove returned an unreadable response. Please try again.",
          response.ok ? 502 : response.status,
          requestId,
          read,
          null,
          !read,
        );
      }
      if (response.ok) return data as T;
      const message =
        data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error
          : "Cove could not complete this request. Please try again.";
      failure = new CoveRequestError(
        message,
        response.status,
        requestId,
        retryStatuses.has(response.status),
        retryDelay(response.headers.get("retry-after")),
        !read && response.status >= 500,
      );
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
      failure =
        error instanceof CoveRequestError
          ? error
          : new CoveRequestError(
              read
                ? "Cove could not be reached. Check your connection and try again."
                : "We could not confirm whether your change completed. Refresh before submitting again.",
              0,
              null,
              true,
              null,
              !read,
            );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
    if (
      read &&
      options.retryReads !== false &&
      attempt === 0 &&
      failure.retryable &&
      (failure.retryAfterSeconds === null || failure.retryAfterSeconds <= 2)
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, (failure.retryAfterSeconds ?? 0.35) * 1000),
      );
      continue;
    }
    throw failure;
  }
}
