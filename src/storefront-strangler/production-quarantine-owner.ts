import {
  maintenanceBusinessRoute,
  productionPersistenceEnrolled,
  type ProductionPersistenceEnv,
} from "./production-persistence-enrollment";
import { currentLegalBaselineQuarantineReady } from "./current-legal-owner-baseline";
import type { AuthoritySql } from "./legal-authority-core";
import { hasPublicationOwner } from "./publication-owner-routing.server";

export const QUARANTINE_STATUS = "/production/quarantine-status";
const businessDatabases = new WeakSet<object>();
export function bindProductionQuarantineBusinessDb<T extends object>(db: T, env: QuarantineEnv): T {
  if (
    !productionQuarantineConfigured(env) ||
    db === env.PRIMARY_DB ||
    db === env.LITERARY_CONTENT_DB ||
    !hasPublicationOwner(db)
  )
    throw Error("production_quarantine_private_business_context_required");
  businessDatabases.add(db);
  return db;
}
export function hasProductionQuarantineBusinessDb(db: unknown): boolean {
  return !!db && typeof db === "object" && businessDatabases.has(db);
}
export type QuarantineEnv = ProductionPersistenceEnv & {
  COVE_PRODUCTION_QUARANTINE_OWNER_ENABLED?: string;
};

// Reuse every physical enrollment check. The original maintenance enrollment
// still accepts ONLY disabled positive authority. A separate mode must also
// prove the persisted all-deny head inside the actual owner before dispatch.
export function productionQuarantineConfigured(env: QuarantineEnv) {
  return (
    env.COVE_PRODUCTION_QUARANTINE_OWNER_ENABLED === "1" &&
    env.COVE_RIGHTS_OWNER_ENABLED === "1" &&
    productionPersistenceEnrolled({ ...env, COVE_RIGHTS_OWNER_ENABLED: "0" })
  );
}
export function productionOwnerConfigured(env: QuarantineEnv) {
  return [undefined, "0"].includes(env.COVE_PRODUCTION_QUARANTINE_OWNER_ENABLED)
    ? productionPersistenceEnrolled(env)
    : productionQuarantineConfigured(env);
}
export function productionQuarantineReady(env: QuarantineEnv, sql: AuthoritySql) {
  return productionQuarantineConfigured(env) ? currentLegalBaselineQuarantineReady(sql) : null;
}
// These exact commands can remove access or reconcile an already authorized
// financial refund. Their original schemas, provider checks and durable vetoes
// still run. No grant, settlement, recovery, raw SQL or generic action RPC.
const negativeCommands = new Set([
  "/commercial/order/revoke",
  "/commercial/refund/reserve",
  "/commercial/refund/record-provider",
  "/commercial/refund/post-accounting",
]);
export function quarantineNegativeCommand(request: Request) {
  const url = new URL(request.url);
  return (
    url.origin === "https://legal-authority.internal" &&
    !url.search &&
    request.method === "POST" &&
    request.headers.get("content-type")?.split(";")[0]?.trim() === "application/json" &&
    !request.headers.has("cookie") &&
    negativeCommands.has(url.pathname)
  );
}
export function quarantineBusinessRoute(request: Request) {
  if (maintenanceBusinessRoute(request)) return true;
  const url = new URL(request.url);
  return (
    !url.search && request.method === "POST" && url.pathname === "/api/fore/admin/commerce/refund"
  );
}
