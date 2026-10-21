// Run-scoped, strictly staging-only Worker identities. Immutable inputs
// prevent one benchmark attempt from deleting another attempt's infrastructure.
export function thinRunWorkerNames(runId) {
  if (typeof runId !== "string" || !/^[0-9]{8,14}$/.test(runId))
    throw Error("A GitHub Actions numeric run ID is required for isolated stage Workers");
  const result = {
    baseline: "cove-thin-control-" + runId,
    core: "cove-thin-core-" + runId,
    thin: "cove-thin-pilot-" + runId,
    ingress: "cove-thin-ingress-" + runId,
  };
  if (new Set(Object.values(result)).size !== 4)
    throw Error("Staging Worker names are not unique");
  for (const name of Object.values(result)) {
    if (!/^cove-thin-[a-z]+-[0-9]{8,14}$/.test(name) || name.length > 63)
      throw Error("Invalid staging-only Worker name");
  }
  return result;
}

export function scopedStageConfigs(thin, ingress, names, expectedD1) {
  if (thin?.d1_databases?.length !== 1 ||
      thin.d1_databases[0]?.database_id !== expectedD1 ||
      thin?.vars?.COVE_SSR_STAGING !== "1" ||
      thin?.vars?.COVE_THIN_STOREFRONT !== "synthetic-only" ||
      thin?.routes || thin?.route || thin?.r2_buckets ||
      ingress?.routes || ingress?.route || ingress?.d1_databases ||
      ingress?.r2_buckets || ingress?.workers_dev !== true)
    throw Error("Refusing to create a non-synthetic or publicly routed stage config");
  if (thin.services?.length !== 1 || thin.services[0].binding !== "CORE" ||
      ingress.services?.length !== 2 ||
      !ingress.services.some((s) => s.binding === "THIN") ||
      !ingress.services.some((s) => s.binding === "BASELINE"))
    throw Error("Expected staging service-binding topology changed");
  const scopedThin = structuredClone(thin);
  scopedThin.name = names.thin;
  scopedThin.services[0].service = names.core;
  const scopedIngress = structuredClone(ingress);
  scopedIngress.name = names.ingress;
  for (const service of scopedIngress.services)
    service.service = service.binding === "THIN" ? names.thin : names.baseline;
  if (scopedIngress.services.some((service) =>
      !Object.values(names).includes(service.service)))
    throw Error("Unscoped stage service binding detected");
  return { thin: scopedThin, ingress: scopedIngress };
}
