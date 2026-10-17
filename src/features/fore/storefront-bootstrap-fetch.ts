import type { StorefrontBootstrap } from "./storefront-bootstrap";

type RetryKind = "http" | "network" | "timeout" | "invalid-contract" | "caller-cancelled";
export type BootstrapFailure = {
  attempt: number;
  kind: RetryKind;
  status?: number;
};

/**
 * Retry a transient upstream failure only within one shared SSR deadline.
 * Every attempt reuses the SAME live visitor context; never fall back to cached
 * editions from another locale/territory or an unverified bundled catalog.
 */
export async function requestStorefrontBootstrap(
  source: Request,
  fetchApi: (request: Request) => Promise<Response>,
  options: {
    timeoutMs?: number;
    firstAttemptMs?: number;
    onFailure?: (failure: BootstrapFailure) => void;
  } = {},
): Promise<string | null> {
  const totalBudget = Math.max(1, Math.min(12_000, options.timeoutMs ?? 10_000));
  const firstBudget = Math.max(1, Math.min(totalBudget, options.firstAttemptMs ?? 6_500));
  const deadline = performance.now() + totalBudget;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (source.signal.aborted) return null;
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return null;
    const signal = AbortSignal.any([
      source.signal,
      AbortSignal.timeout(
        Math.max(1, Math.min(remaining, attempt === 1 ? firstBudget : remaining)),
      ),
    ]);
    try {
      const forwarded = new Request(source.url, { method: "GET", headers: source.headers, signal });
      const response = await fetchApi(forwarded);
      if (!response.ok) {
        options.onFailure?.({ attempt, kind: "http", status: response.status });
        if (![429, 502, 503, 504].includes(response.status)) return null;
        continue;
      }
      const value: StorefrontBootstrap = await response.json();
      if (
        !value ||
        !value.context?.rightsCountry ||
        !value.context.locale ||
        !value.context.currency ||
        !Array.isArray(value.catalog?.results) ||
        !Number.isFinite(value.at)
      ) {
        options.onFailure?.({ attempt, kind: "invalid-contract" });
        return null;
      }
      return JSON.stringify(value);
    } catch (error) {
      const kind: RetryKind = source.signal.aborted
        ? "caller-cancelled"
        : signal.aborted
          ? "timeout"
          : "network";
      options.onFailure?.({ attempt, kind });
      if (source.signal.aborted) return null;
    }
  }
  return null;
}
