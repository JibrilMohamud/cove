/**
 * Closed QA operational commands. No arbitrary SQL, native database handle,
 * customer identity, legal grant, checkout, payment or entitlement command
 * crosses this boundary. This protocol cannot enroll production.
 */
import { z } from "zod/v3";

export const QA_OPERATIONAL_ROUTE = "/qa/private-operational-write";
export const QA_OPERATIONAL_SCHEMA = "cove.qa.operational-write.v1";
const uuid = z.string().uuid();
const iso = z.string().datetime();
const key = z
  .string()
  .regex(
    /^(?:search-counts:v1:|search-facets:v2:|search-page:v1:|taxonomy-counts:v1:|public-api:v2:)[a-f0-9]{64}$/,
  );
const leaseKey = z
  .string()
  .regex(/^(?:taxonomy-counts-refresh:v1:global|search-facets-refresh:v2:[a-f0-9]{64})$/);
const millis = z.number().int().nonnegative().safe();
const jsonText = z.string().max(262144);
const guard = z.object({ key: leaseKey, owner: uuid, nowMs: millis }).strict();
const requestId = z.string().regex(/^[A-Za-z0-9._:-]{8,160}$/);
const traceId = z.string().regex(/^[a-f0-9]{32}$/);
const spanId = z.string().regex(/^[a-f0-9]{16}$/);
const action = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cache.write"),
      key,
      body: jsonText,
      expiresAt: millis,
      prefix: z.enum([
        "search-counts:v1:",
        "search-facets:v2:",
        "search-page:v1:",
        "taxonomy-counts:v1:",
        "public-api:v2:",
      ]),
      limit: z.union([z.literal(128), z.literal(256)]),
      guard: guard.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cache.lease-acquire"),
      key: leaseKey,
      owner: uuid,
      expiresAt: millis,
    })
    .strict(),
  z.object({ kind: z.literal("cache.lease-release"), key: leaseKey, owner: uuid }).strict(),
  z
    .object({
      kind: z.literal("search.impression"),
      id: uuid,
      // Synthetic anonymous search only: this route cannot assert a user ID.
      query: z.string().max(512),
      normalizedQuery: z.string().max(1024),
      filtersJson: z.string().max(32768),
      sort: z.string().max(40),
      count: millis,
      backend: z.enum(["d1-fts5", "meilisearch"]),
      duration: millis,
      correctedQuery: z.string().max(512).nullable(),
      impressionsJson: z.string().max(32768),
      at: iso,
    })
    .strict(),
  z
    .object({
      kind: z.literal("audit.http"),
      requestId,
      traceId,
      spanId,
      parentSpanId: spanId.nullable(),
      startedAt: iso,
      endedAt: iso,
      duration: millis,
      method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
      route: z
        .string()
        .min(10)
        .max(512)
        .regex(/^\/api\/fore\/[^?#]*$/)
        .refine(
          (value) =>
            [...value].every((character) => {
              const code = character.charCodeAt(0);
              return code >= 32 && code !== 127;
            }),
          "Control characters are not valid route labels",
        ),
      status: z.number().int().min(100).max(599),
      actorKind: z.enum(["anonymous", "user"]),
      storefrontCountry: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .nullable(),
      errorClass: z.string().max(120).nullable(),
    })
    .strict(),
]);

export type QaOperationalAction = z.input<typeof action>;
export const operationalCommand = z
  .object({
    schema: z.literal(QA_OPERATIONAL_SCHEMA),
    operationId: uuid,
    action,
  })
  .strict();

const QA_PRIMARIES = new Set([
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
  "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3",
]);
type Port = { fetch(request: Request): Promise<Response> };
type Enrollment = {
  COVE_QA_OPERATIONAL_OWNER_ENABLED?: string;
  COVE_QA_OWNER_UNBOUND_READ_ENABLED?: string;
  FORE_ENVIRONMENT?: string;
  COVE_SSR_STAGING?: string;
  COVE_RIGHTS_OWNER_ENABLED?: string;
  COVE_RIGHTS_OWNER_PRIMARY_ID?: string;
  COVE_LEGAL_WRITER_PRIMARY_ID?: string;
  COVE_PUBLICATION_COMMAND_TERRITORY?: string;
  COVE_PUBLICATION_COMMAND_CURRENCY?: string;
  COVE_RIGHTS_OWNER_SECRET?: string;
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT?: string;
  COVE_OWNER_EXCLUSIVE_WRITER_FENCE?: string;
  COVE_COMMERCE_OWNER_D1_FENCE?: string;
  COVE_PUBLICATION_COMMANDS_ENABLED?: string;
  STRIPE_LIVEMODE?: string;
  STRIPE_SECRET_KEY?: string;
};
export function qaOperationalEnrolled(env: Enrollment) {
  const now = Date.now(),
    expiry = Number(env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT);
  return (
    env.COVE_QA_OPERATIONAL_OWNER_ENABLED === "1" &&
    env.FORE_ENVIRONMENT === "staging" &&
    env.COVE_SSR_STAGING === "1" &&
    env.COVE_QA_OWNER_UNBOUND_READ_ENABLED === "1" &&
    env.COVE_RIGHTS_OWNER_ENABLED === "1" &&
    QA_PRIMARIES.has(env.COVE_RIGHTS_OWNER_PRIMARY_ID || "") &&
    env.COVE_LEGAL_WRITER_PRIMARY_ID === env.COVE_RIGHTS_OWNER_PRIMARY_ID &&
    env.COVE_PUBLICATION_COMMAND_TERRITORY === "US" &&
    env.COVE_PUBLICATION_COMMAND_CURRENCY === "USD" &&
    /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET || "") &&
    Number.isSafeInteger(expiry) &&
    expiry > now &&
    expiry <= now + 15 * 60_000 &&
    env.STRIPE_LIVEMODE !== "true" &&
    (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY.startsWith("sk_test_")) &&
    [undefined, "0"].includes(env.COVE_OWNER_EXCLUSIVE_WRITER_FENCE) &&
    [undefined, "0"].includes(env.COVE_COMMERCE_OWNER_D1_FENCE) &&
    [undefined, "0"].includes(env.COVE_PUBLICATION_COMMANDS_ENABLED)
  );
}
const contexts = new WeakMap<object, { owner: Port; env: Enrollment }>();

export function bindQaOperationalOwner<T extends object>(db: T, owner: Port, env: Enrollment): T {
  if (
    !qaOperationalEnrolled(env) ||
    typeof owner?.fetch !== "function" ||
    Object.values(env).some(
      (value) =>
        value &&
        typeof value === "object" &&
        typeof (value as { prepare?: unknown }).prepare === "function",
    )
  )
    throw Error("qa_operational_caller_not_enrolled");
  contexts.set(db, { owner, env });
  return db;
}

/** No context is the unchanged native path. An enrolled but failed remote
 * command must reject, NEVER fall back to caller SQL. Only the actual
 * read-only facade created at the backend boundary receives this context. */
export function dispatchQaOperationalWrite(
  db: object,
  input: QaOperationalAction,
): Promise<boolean> | null {
  const context = contexts.get(db);
  if (!context) return null;
  return (async () => {
    if (!qaOperationalEnrolled(context.env)) throw Error("qa_operational_lease_expired");
    const command = operationalCommand.parse({
      schema: QA_OPERATIONAL_SCHEMA,
      operationId: crypto.randomUUID(),
      action: input,
    });
    const response = await context.owner.fetch(
      new Request("https://legal-authority.internal" + QA_OPERATIONAL_ROUTE, {
        method: "POST",
        headers: {
          authorization: "Bearer " + context.env.COVE_RIGHTS_OWNER_SECRET,
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify(command),
      }),
    );
    if (response.status !== 200 || response.headers.get("cache-control") !== "no-store")
      throw Error("qa_operational_owner_not_acknowledged");
    const raw = await response.text();
    if (raw.length > 1024) throw Error("qa_operational_receipt_invalid");
    const receipt = z
      .object({
        schema: z.literal(QA_OPERATIONAL_SCHEMA),
        operationId: uuid,
        kind: z.string(),
        completed: z.boolean(),
      })
      .strict()
      .parse(JSON.parse(raw));
    if (
      receipt.operationId !== command.operationId ||
      receipt.kind !== command.action.kind ||
      (!receipt.completed && command.action.kind !== "cache.lease-acquire")
    )
      throw Error("qa_operational_receipt_invalid");
    return receipt.completed;
  })();
}
