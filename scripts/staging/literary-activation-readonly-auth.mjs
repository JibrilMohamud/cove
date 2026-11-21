/**
 * Protected literary activation audit: two independent provider-enforced
 * READ credentials. No token can be selected by an arbitrary API path.
 * This module does not authorize a literary cutover or a D1 mutation.
 */
const databases = new Set([
  "4bd657ac-8789-403e-a28c-93aba8d0a989", // Cove primary
  "400c3af3-5d40-41fd-83cc-98228e40ddac", // isolated originals
  "fce5742c-29ca-4bc3-85da-e174dd9bf42e", // private QA publication
  "24c0eda2-6a43-4d7e-b787-502745d4d781", // private QA primary
]);
const workers = new Set([
  "cove-literary-handoff-isolated-disabled",
  "cove-literary-prepare-isolated-disabled",
  "cove-literary-infer-isolated-disabled",
  "cove-literary-publisher-isolated-disabled",
  "cove-persistence-backend",
]);

function requiredCredential(value) {
  if (typeof value !== "string" || value.length < 20)
    throw Error("literary_activation_scoped_read_credential_unavailable");
  return value;
}

/** GET requests only inspect exact approved worker metadata. POST requests
 * only execute Cloudflare D1 Read SQL against reviewed database identities. */
export function literaryActivationReadCredential(method, path, body, env = process.env) {
  if (method === "GET" && body === undefined) {
    const script = /^\/workers\/scripts\/([a-z0-9-]+)\/(settings|schedules|deployments)$/.exec(
      path,
    );
    const worker = /^\/workers\/workers\/([a-z0-9-]+)$/.exec(path);
    if (
      (script && workers.has(script[1])) ||
      (worker && workers.has(worker[1]))
    )
      return requiredCredential(env.COVE_CF_WORKERS_METADATA_READ_TOKEN);
  }
  if (method === "POST") {
    const match = /^\/d1\/database\/([0-9a-f-]{36})\/query$/.exec(path);
    if (
      match &&
      databases.has(match[1]) &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).join(",") === "sql" &&
      typeof body.sql === "string" &&
      body.sql.length <= 4096 &&
      (/^\s*SELECT\b/i.test(body.sql) ||
        /^\s*PRAGMA\s+table_info\(literary_inference_jobs\)\s*$/i.test(body.sql)) &&
      !/;|--|\/\*|\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|ATTACH|DETACH|VACUUM)\b/i.test(
        body.sql,
      )
    )
      return requiredCredential(env.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN);
  }
  throw Error("literary_activation_unreviewed_read_endpoint_denied");
}
