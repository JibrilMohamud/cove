/* No network access. Exact control-plane scope for the disabled-owner handshake. */
export const COVE_ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const base = `/accounts/${COVE_ACCOUNT}/workers/scripts/`;
const ownerSettings = base + "cove-legal-authority-production/settings";
const backendSettings = base + "cove-persistence-backend/settings";
const subdomain = `/accounts/${COVE_ACCOUNT}/workers/subdomain`;

export function checkedOwnerHandshakeTokens(env) {
  const read = env?.COVE_CF_WORKERS_METADATA_READ_TOKEN;
  const write = env?.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN;
  if (
    typeof read !== "string" ||
    read.length < 20 ||
    typeof write !== "string" ||
    write.length < 20 ||
    read === write
  )
    throw new Error("owner_handshake_scoped_cloudflare_credentials_required");
  return { read, write };
}

export function ownerHandshakeTokenFor(method, path, worker, credentials) {
  if (!/^cove-owner-handshake-[a-f0-9]{16}$/.test(worker))
    throw new Error("owner_handshake_ephemeral_worker_invalid");
  const temporary = base + worker;
  if (
    method === "GET" &&
    (path === ownerSettings || path === backendSettings || path === temporary + "/settings")
  )
    return credentials.read;
  if (method === "GET" && path === subdomain) return credentials.write;
  if (
    (method === "PUT" && path === temporary) ||
    (method === "POST" && path === temporary + "/subdomain") ||
    (method === "DELETE" && path === temporary)
  )
    return credentials.write;
  // No account token enumeration, D1, primary owner modification, or other
  // Worker deployment is a valid operation in this proof.
  throw new Error("owner_handshake_cloudflare_operation_not_reviewed");
}
