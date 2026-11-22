// This audit can observe bindings and routing, never mutate either.
export const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
export const ZONE = "07e218b2e74bc522122e0994b8e37576";
const root = `/accounts/${ACCOUNT}/workers/`;
const metadataPaths = new Set(
  ["cove", "cove-persistence-backend", "cove-legal-authority-production"].map(
    (name) => root + "scripts/" + name + "/settings",
  ),
);
const routePaths = new Set([root + "domains", `/zones/${ZONE}/workers/routes`]);

export function topologyReadCredentials(env) {
  const metadata = env.COVE_CF_WORKERS_METADATA_READ_TOKEN;
  const routing = env.COVE_CF_WORKERS_TOPOLOGY_READ_TOKEN;
  if (
    env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT ||
    env.CLOUDFLARE_ZONE_ID !== ZONE ||
    typeof metadata !== "string" ||
    metadata.length < 20 ||
    typeof routing !== "string" ||
    routing.length < 20 ||
    metadata === routing
  )
    throw Error("topology_independent_read_credentials_required");
  return { metadata, routing };
}

export function createTopologyReader(env, fetchImpl = fetch) {
  const credentials = topologyReadCredentials(env);
  let calls = 0;
  return async function get(path, { optional = false } = {}) {
    const token = metadataPaths.has(path)
      ? credentials.metadata
      : routePaths.has(path)
        ? credentials.routing
        : null;
    if (!token) throw Error("topology_read_endpoint_denied");
    // The frontend Worker alone may be absent. Missing owner/backend/routing
    // evidence must never be converted into an empty, apparently safe topology.
    if (optional && path !== root + "scripts/cove/settings")
      throw Error("topology_optional_endpoint_denied");
    if (++calls > 5) throw Error("topology_read_budget_exhausted");
    let response;
    try {
      response = await fetchImpl("https://api.cloudflare.com/client/v4" + path, {
        method: "GET",
        headers: { authorization: "Bearer " + token, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw Error("topology_read_transport_unavailable");
    }
    if (optional && response.status === 404) return null;
    if (response.status !== 200) throw Error("topology_read_http_failure");
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw Error("topology_read_invalid_response");
    }
    if (
      payload?.success !== true ||
      !Array.isArray(payload.errors) ||
      payload.errors.length ||
      payload.result === null ||
      typeof payload.result !== "object"
    )
      throw Error("topology_read_invalid_response");
    return payload.result;
  };
}
