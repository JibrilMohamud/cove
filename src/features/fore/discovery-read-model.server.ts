import type { CatalogDB } from "./catalog-model.server";
import { ApiError } from "./service";

/** Private, neutral projections only. No user data or legal authorization is stored here. */
export type DiscoveryModelStore = {
  get(key: string): Promise<{ size: number; text(): Promise<string> } | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata: { contentType: string } },
  ): Promise<unknown>;
};
export type DiscoveryReadEnv = {
  DISCOVERY_MODELS?: DiscoveryModelStore;
  FORE_DISCOVERY_READ_MODE?: string;
};
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 5 * 60_000;
function scopeKey(kind: string, scope: string) {
  if (!/^[a-z-]{1,40}$/.test(kind) || !/^[A-Za-z0-9_-]{1,80}$/.test(scope))
    throw new Error("Invalid discovery projection scope");
  return `discovery/v1/${kind}/${scope}`;
}
export function requiresDiscoveryReadModel(env: DiscoveryReadEnv) {
  return env.FORE_DISCOVERY_READ_MODE === "required";
}
export async function publishDiscoveryModel<T>(
  env: DiscoveryReadEnv,
  kind: string,
  scope: string,
  data: T,
) {
  if (!env.DISCOVERY_MODELS) throw new ApiError(503, "Discovery model storage is unavailable.");
  const key = scopeKey(kind, scope);
  const revision = crypto.randomUUID();
  const generatedAt = Date.now();
  const bytes = JSON.stringify({ schema: 1, kind, scope, revision, generatedAt, data });
  if (new TextEncoder().encode(bytes).length > MAX_BYTES)
    throw new Error("Discovery projection exceeds size budget");
  const options = { httpMetadata: { contentType: "application/json" } };
  // Publish a complete immutable version before atomically switching the pointer. A failed
  // write never exposes partial JSON. A sole scheduled producer owns each scope.
  await env.DISCOVERY_MODELS.put(`${key}/${revision}.json`, bytes, options);
  await env.DISCOVERY_MODELS.put(
    `${key}/current.json`,
    JSON.stringify({ revision, generatedAt }),
    options,
  );
  return { revision, generatedAt };
}
export async function loadDiscoveryModel<T>(
  env: DiscoveryReadEnv,
  kind: string,
  scope: string,
  validate: (value: unknown) => T,
): Promise<T> {
  if (!env.DISCOVERY_MODELS) throw new ApiError(503, "Discovery model storage is unavailable.");
  const key = scopeKey(kind, scope);
  try {
    const pointer = await env.DISCOVERY_MODELS.get(`${key}/current.json`);
    if (!pointer || pointer.size > 1024) throw new Error("Missing projection pointer");
    const { revision, generatedAt } = JSON.parse(await pointer.text());
    if (!/^[a-f0-9-]{36}$/.test(revision) || !Number.isSafeInteger(generatedAt))
      throw new Error("Invalid projection pointer");
    const age = Date.now() - generatedAt;
    if (age < -5000 || age > MAX_AGE_MS) throw new Error("Discovery projection expired");
    const blob = await env.DISCOVERY_MODELS.get(`${key}/${revision}.json`);
    if (!blob || blob.size > MAX_BYTES) throw new Error("Missing or oversized projection");
    const payload = JSON.parse(await blob.text());
    if (
      payload.schema !== 1 ||
      payload.kind !== kind ||
      payload.scope !== scope ||
      payload.revision !== revision ||
      payload.generatedAt !== generatedAt
    )
      throw new Error("Projection version/scope mismatch");
    return validate(payload.data);
  } catch {
    // Never regenerate on a miss: that would stampede the primary database during an outage.
    throw new ApiError(503, "Discovery is temporarily unavailable. Please try again shortly.");
  }
}

/** Candidate production may tolerate replica lag; delivery authorization never does. */
export function discoveryProductionEnv<T extends DiscoveryReadEnv & { DB: CatalogDB }>(env: T): T {
  const db = env.DB as CatalogDB & {
    withSession?: (constraint: "first-unconstrained") => CatalogDB;
  };
  return db.withSession ? { ...env, DB: db.withSession("first-unconstrained") } : env;
}
