import { trustedWorkerCountry } from "./cloudflare-country.server";

/**
 * Nitro's Cloudflare preset can pass a Node-compatible process.env object
 * into the application SSR entry instead of the native Worker binding object.
 * Never mistake successful configuration-variable access for access to D1.
 *
 * Cloudflare documents 'cloudflare:workers' as the request-local authority
 * for bindings. Load it only in a Cloudflare request that actually needs it;
 * never create a process-global catalog, market, or user-scoped cache.
 */
export async function resolveNativeWorkerBindings(
  request: Request,
  provided: unknown,
  loadBindings: () => Promise<unknown> = async () => {
    const moduleName = "cloudflare:workers";
    const module = await import(/* @vite-ignore */ moduleName);
    return module.env;
  },
): Promise<Record<string, unknown>> {
  const current =
    provided && typeof provided === "object" ? (provided as Record<string, unknown>) : {};
  const existingDb = current.DB as { prepare?: unknown } | undefined;
  if (typeof existingDb?.prepare === "function") return current;

  // A Vercel response or spoofable HTTP country header is not permission to
  // load Worker bindings. The staging flag can also identify our own Worker
  // when a framework wrapper has reconstructed the original Request.
  const cloudflareRequest = trustedWorkerCountry(request) !== null;
  if (!cloudflareRequest && current.COVE_SSR_STAGING !== "1") return current;

  try {
    const bindings = await loadBindings();
    if (!bindings || typeof bindings !== "object") return current;
    const worker = bindings as Record<string, unknown>;
    const db = worker.DB as { prepare?: unknown } | undefined;
    if (typeof db?.prepare !== "function") return current;
    // Preserve the native binding object's variables, especially the
    // staging authentication secret; do not overwrite them with a stale
    // Node process.env value or user-controlled request header.
    return { ...current, ...worker };
  } catch {
    // Strict fail-closed behavior: absence of D1 will produce the existing
    // controlled 503. Never fall back to a seeded or cached public catalog.
    return current;
  }
}
