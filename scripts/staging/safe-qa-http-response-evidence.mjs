/**
 * Small, privacy-safe diagnostic projection for the protected synthetic QA
 * transport harness. Never read/store header values other than allowlisted
 * numeric phase clocks and ephemeral Cloudflare Ray/colo identifiers.
 */
export function safeQaHttpResponseEvidence(headers) {
  const get = (key) => headers?.get?.(key) ?? null;
  const ray = get("cf-ray");
  const colo = get("x-cove-qa-ingress-colo");
  const layer = get("x-cove-qa-unavailable-layer");
  const placement = get("cf-placement");
  return {
    ray: typeof ray === "string" && /^[a-f0-9]{12,32}-[A-Z]{3}$/.test(ray) ? ray : null,
    ingressColo: typeof colo === "string" && /^[A-Z]{3}$/.test(colo) ? colo : null,
    unavailableLayer: ["caller", "owner", "writer"].includes(layer) ? layer : null,
    cfPlacement:
      typeof placement === "string" && /^(local|remote)-[A-Z]{3}$/.test(placement)
        ? placement
        : null,
  };
}
