import { inspectUserTokenEvidence } from "./certify-exclusive-primary-d1.mjs";

/**
 * Private remediation only. Reuse the same strict classifier for each token,
 * preserving the complete-inventory result and capturing provider catalog
 * definitions corresponding to unverified active policies. Never authorize.
 */
export async function diagnoseUserTokenRemediation(get, key) {
  const inventory = await get("/user/tokens", key);
  const rows = inventory.result;
  const info = inventory.result_info;
  if (
    !Array.isArray(rows) ||
    info?.page !== 1 ||
    info.count !== rows.length ||
    info.total_count !== rows.length ||
    (info.total_pages !== undefined && info.total_pages !== 1) ||
    rows.length > 100 ||
    rows.some((row) => !/^[a-f0-9]{32}$/.test(row?.id || "")) ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    throw Error("private_token_inventory_incomplete");
  const full = await inspectUserTokenEvidence(
    (path, token) => (path === "/user/tokens" ? inventory : get(path, token)),
    key,
  );
  const findings = [];
  for (const row of rows) {
    if (row.status !== "active") continue;
    const catalog = new Map();
    const evidence = await inspectUserTokenEvidence(async (path, token) => {
      if (path === "/user/tokens")
        return { result: [row], result_info: { page: 1, count: 1, total_count: 1 } };
      const response = await get(path, token);
      for (const group of response.result || []) {
        if (/^[a-f0-9]{32}$/.test(group?.id || "") && typeof group.name === "string") {
          const previous = catalog.get(group.id);
          if (previous && previous !== group.name) throw Error("private_catalog_conflict");
          catalog.set(group.id, group.name);
        }
      }
      return response;
    }, key);
    if (!evidence.verified) {
      findings.push({
        tokenId: row.id,
        tokenName: row.name,
        evidence,
        groups: (row.policies || []).flatMap((policy) =>
          (policy.permission_groups || []).map((group) => ({
            id: group.id,
            policyLabel: group.name,
            providerName: catalog.get(group.id) || null,
          })),
        ),
      });
    }
  }
  return {
    schema: "cove.private-user-token-remediation.v1",
    full,
    findings,
    releaseCertified: false,
    mutationPerformed: false,
  };
}
