import type { StorefrontBootstrap } from "./storefront-bootstrap";

export type HedgedStorefrontPhase = "primary" | "alternate";
export type HedgedStorefrontOutcome = "ok" | "denied" | "invalid" | "unavailable" | "timeout";

type Result = { kind: "ok"; value: string } | { kind: "denied" } | { kind: "unavailable" };

type ResultWithPhase = Result & { phase: HedgedStorefrontPhase };

/**
 * Vercel cold invocations can stall all outbound I/O. Start a single,
 * independently authorized API probe while the original backend call is still
 * pending instead of wasting 3.5s and then retrying the same stuck transport.
 * No snapshot or stale rights data is ever accepted.
 */
export async function hedgedStorefrontBootstrap(
  source: Request,
  primary: (request: Request) => Promise<Response>,
  alternate: (request: Request) => Promise<Response>,
  options: {
    hedgeAfterMs?: number;
    timeoutMs?: number;
    onPhase?: (
      phase: HedgedStorefrontPhase,
      outcome: HedgedStorefrontOutcome,
      durationMs: number,
    ) => void;
    onDeadline?: (state: {
      countryAsserted: boolean;
      primaryCompleted: boolean;
      alternateStarted: boolean;
      alternateCompleted: boolean;
    }) => void;
  } = {},
): Promise<string | null> {
  if (source.signal.aborted) return null;
  const timeoutMs = Math.max(1, Math.min(12_000, options.timeoutMs ?? 8_000));
  const hedgeAfterMs = Math.max(1, Math.min(timeoutMs, options.hedgeAfterMs ?? 1_650));
  // AbortSignal.timeout uses an unref'ed Node timer; it may never fire if
  // all outbound requests are stalled promises without active I/O handles.
  // A referenced timer is essential: cold SSR must have a real hard deadline.
  const deadlineController = new AbortController();
  const expiration = deadlineController.signal;
  const deadlineTimer = setTimeout(() => deadlineController.abort(), timeoutMs);
  const primaryCtrl = new AbortController();
  const alternateCtrl = new AbortController();
  const sourceCountry = source.headers.get("x-vercel-ip-country")?.trim().toUpperCase() || "";
  const validCountry = /^[A-Z]{2}$/.test(sourceCountry);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let primaryCompleted = false;
  let alternateStarted = false;
  let alternateCompleted = false;
  let onCallerAbort: () => void = () => {};
  const timeout = new Promise<"expired">((resolve) => {
    expiration.addEventListener("abort", () => resolve("expired"), { once: true });
    onCallerAbort = () => resolve("expired");
    source.signal.addEventListener("abort", onCallerAbort, { once: true });
  });

  async function tryRequest(
    phase: HedgedStorefrontPhase,
    api: (request: Request) => Promise<Response>,
    controller: AbortController,
  ): Promise<ResultWithPhase> {
    const started = performance.now();
    const signal = AbortSignal.any([source.signal, expiration, controller.signal]);
    let outcome: HedgedStorefrontOutcome = "unavailable";
    try {
      const url = new URL("/api/fore/storefront/bootstrap", source.url);
      const response = await api(
        new Request(url, { headers: source.headers, signal, redirect: "manual" }),
      );
      if (!response.ok) {
        const denied = phase === "primary" && [401, 403, 404].includes(response.status);
        // A stream-cancellation failure must never reclassify a 403 denial
        // as a transient error that can be overridden by the alternate.
        if (denied) outcome = "denied";
        try {
          await response.body?.cancel();
        } catch {
          // The HTTP status remains authoritative even if cleanup fails.
        }
        return denied ? { phase, kind: "denied" } : { phase, kind: "unavailable" };
      }
      // An alternate Vercel invocation cannot supply the definitive country.
      // Require the original trusted platform country and remote backend proof.
      if (
        phase === "alternate" &&
        (!validCountry || response.headers.get("x-cove-persistence") !== "remote-d1-r2")
      ) {
        outcome = "invalid";
        await response.body?.cancel();
        return { phase, kind: "unavailable" };
      }
      const value: StorefrontBootstrap = await response.json();
      if (
        !value ||
        !/^[A-Z]{2}$/.test(value.context?.rightsCountry || "") ||
        !value.context.locale ||
        !value.context.currency ||
        !Array.isArray(value.context.availableMarkets) ||
        !value.page ||
        !value.page.query ||
        !Array.isArray(value.catalog?.results) ||
        value.catalog.results.length === 0 ||
        !value.catalog.results.every((book) => typeof book?.productId === "string") ||
        typeof value.catalogQuery !== "string" ||
        !Number.isFinite(value.at) ||
        (validCountry && value.context.rightsCountry !== sourceCountry)
      ) {
        outcome = "invalid";
        return { phase, kind: "unavailable" };
      }
      outcome = "ok";
      return { phase, kind: "ok", value: JSON.stringify(value) };
    } catch {
      outcome = signal.aborted ? "timeout" : "unavailable";
      return { phase, kind: "unavailable" };
    } finally {
      if (phase === "primary") primaryCompleted = true;
      else alternateCompleted = true;
      options.onPhase?.(phase, outcome, performance.now() - started);
    }
  }

  const primaryPromise = tryRequest("primary", primary, primaryCtrl);
  try {
    const hedgeTimer = new Promise<"hedge">((resolve) => {
      timer = setTimeout(() => resolve("hedge"), hedgeAfterMs);
    });
    const first = await Promise.race<ResultWithPhase | "hedge" | "expired">([
      primaryPromise,
      hedgeTimer,
      timeout,
    ]);
    if (first === "expired") return null;
    if (first !== "hedge") {
      if (first.kind === "ok") return first.value;
      if (first.kind === "denied") return null;
    }
    if (source.signal.aborted || expiration.aborted) return null;
    if (!validCountry) {
      // Without an original platform-country assertion, a second invocation
      // may have a different IP/territory. Keep waiting for the authoritative
      // first request rather than incorrectly blanking an otherwise healthy SSR.
      const unhedged = await Promise.race<ResultWithPhase | "expired">([primaryPromise, timeout]);
      return unhedged !== "expired" && unhedged.kind === "ok" ? unhedged.value : null;
    }
    alternateStarted = true;
    const alternatePromise = tryRequest("alternate", alternate, alternateCtrl);
    const next =
      first === "hedge"
        ? await Promise.race<ResultWithPhase | "expired">([
            primaryPromise,
            alternatePromise,
            timeout,
          ])
        : await Promise.race<ResultWithPhase | "expired">([alternatePromise, timeout]);
    if (next === "expired") return null;
    if (next.kind === "ok") return next.value;
    if (next.kind === "denied") return null;
    if (first !== "hedge") return null;
    const remaining = next.phase === "primary" ? alternatePromise : primaryPromise;
    const last = await Promise.race<ResultWithPhase | "expired">([remaining, timeout]);
    return last !== "expired" && last.kind === "ok" ? last.value : null;
  } finally {
    // An eight-second deadline can expire while both outbound calls are
    // unresolved; onPhase cannot report a pending request. Emit only a
    // bounded, country-free summary, including whether the safe hedge ran.
    if (expiration.aborted)
      options.onDeadline?.({
        countryAsserted: validCountry,
        primaryCompleted,
        alternateStarted,
        alternateCompleted,
      });
    if (timer) clearTimeout(timer);
    clearTimeout(deadlineTimer);
    source.signal.removeEventListener("abort", onCallerAbort);
    primaryCtrl.abort();
    alternateCtrl.abort();
  }
}
