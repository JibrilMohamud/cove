import {
  checkToken,
  bearer,
  productionBiosyncRequest,
  hashConfigured,
  refuse,
} from "./production-persistence-enrollment";

type Env = {
  COVE_PRODUCTION_BIOSYNC_INGRESS_ENABLED?: string;
  COVE_BIOSYNC_CLIENT_TOKEN_SHA256?: string;
  BIOSYNC_OWNER?: { fetch(request: Request): Promise<Response> };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (
      env.COVE_PRODUCTION_BIOSYNC_INGRESS_ENABLED !== "1" ||
      !hashConfigured(env.COVE_BIOSYNC_CLIENT_TOKEN_SHA256) ||
      !env.BIOSYNC_OWNER?.fetch ||
      Object.keys(env).some(
        (key) =>
          ![
            "COVE_PRODUCTION_BIOSYNC_INGRESS_ENABLED",
            "COVE_BIOSYNC_CLIENT_TOKEN_SHA256",
            "BIOSYNC_OWNER",
          ].includes(key),
      )
    )
      return refuse();
    if (!productionBiosyncRequest(request)) return refuse(404);
    if (!(await checkToken(bearer(request), env.COVE_BIOSYNC_CLIENT_TOKEN_SHA256)))
      return refuse(401);
    // Never retry a possibly committed write. The publisher may safely replay
    // the same immutable command after independently observing its status.
    try {
      return await env.BIOSYNC_OWNER.fetch(request);
    } catch {
      return refuse();
    }
  },
};
