import { ApiError, rateLimit } from "./service";
import type { CoveEnv } from "./api.server";

/**
 * Cloudflare's first-paint read counter is per-colo and approximate; it is not
 * a global business quota. No change to customer, commerce or durable API
 * abuse controls. Without the edge binding, non-Worker origins use D1.
 * Protected native staging fails closed if the binding is missing.
 */
export async function enforceFirstPaintRateLimit(
  env: CoveEnv,
  key: string,
  cap: number,
): Promise<"edge" | "d1"> {
  const limiter = env.COVE_STOREFRONT_READ_LIMITER;
  if (!limiter) {
    if (env.COVE_SSR_STAGING === "1")
      throw new ApiError(503, "Native storefront read limiter is unavailable.");
    await rateLimit(env, key, cap);
    return "d1";
  }
  if (typeof limiter.limit !== "function")
    throw new ApiError(503, "Native storefront read limiter is unavailable.");
  let verdict: { success: boolean };
  try {
    verdict = await limiter.limit({ key });
  } catch {
    throw new ApiError(503, "Native storefront read limiter is unavailable.");
  }
  if (verdict?.success === false)
    throw new ApiError(429, "Please wait a minute before trying again.");
  if (verdict?.success !== true)
    throw new ApiError(503, "Native storefront read limiter is unavailable.");
  return "edge";
}
