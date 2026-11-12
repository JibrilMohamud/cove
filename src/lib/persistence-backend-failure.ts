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
