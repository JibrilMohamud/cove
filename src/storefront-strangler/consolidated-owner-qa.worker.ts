/**
 * Single-physical-owner candidate. The existing legal Durable Object class,
 * default entrypoint, namespace, journals and protected command handlers are
 * reused unchanged. This bundle is deliberately QA-only; never enroll a real
 * production D1 or LIVE Stripe credential through a feature flag.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import legalAuthority, { CoveLegalAuthority } from "./legal-authority.worker";
import backend, { type BackendEnv } from "../persistence-backend.worker";
import type { CatalogDB } from "../features/fore/catalog-model.server";
import { makeStageLegalWriterLock } from "./legal-primary-write-lock";
import { commerceRestrictedCanonicalD1 } from "./commerce-d1-write-fence";
import { bindPublicationOwner } from "./publication-owner-routing.server";
import { checkedQaOwnerReadSql } from "./qa-owner-primary-read-transport.mjs";
import { dispatchQaOwnerScheduledTick } from "./qa-owner-scheduled-execution";

export { CoveLegalAuthority };
type LegalEnv = Parameters<typeof legalAuthority.fetch>[1];
type OwnerEnv = Omit<BackendEnv, "DB"> &
  LegalEnv & {
    COVE_CONSOLIDATED_OWNER_QA?: string;
    COVE_QA_OWNER_UNBOUND_READ_ENABLED?: string;
    COVE_QA_SCHEDULE_OWNER_ENABLED?: string;
  };

const QA_PRIMARY_IDS = new Set([
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
  "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3",
]);

function enrolled(env: OwnerEnv) {
  const now = Date.now();
  const expiry = Number(env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT);
  return (
    env.COVE_CONSOLIDATED_OWNER_QA === "1" &&
    env.FORE_ENVIRONMENT === "staging" &&
    env.COVE_SSR_STAGING === "1" &&
    env.COVE_RIGHTS_OWNER_ENABLED === "1" &&
    QA_PRIMARY_IDS.has(env.COVE_RIGHTS_OWNER_PRIMARY_ID || "") &&
    env.COVE_LEGAL_WRITER_PRIMARY_ID === env.COVE_RIGHTS_OWNER_PRIMARY_ID &&
    env.COVE_PUBLICATION_COMMAND_TERRITORY === "US" &&
    env.COVE_PUBLICATION_COMMAND_CURRENCY === "USD" &&
    /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET || "") &&
    /^[a-f0-9]{64}$/.test(env.FORE_BACKEND_TOKEN_SHA256 || "") &&
    Number.isSafeInteger(expiry) &&
    expiry > now &&
    expiry <= now + 15 * 60_000 &&
    env.STRIPE_LIVEMODE !== "true" &&
    (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY.startsWith("sk_test_")) &&
    [undefined, "0"].includes(env.COVE_QA_OWNER_UNBOUND_READ_ENABLED) &&
    [undefined, "0"].includes(env.COVE_PUBLICATION_COMMANDS_ENABLED) &&
    [undefined, "0"].includes(env.COVE_COMMERCE_OWNER_D1_FENCE) &&
    [undefined, "0"].includes(env.COVE_OWNER_EXCLUSIVE_WRITER_FENCE) &&
    !!env.PRIMARY_DB?.prepare &&
    !!env.PRIMARY_DB?.batch &&
    !!env.LEGAL_AUTHORITY?.getByName &&
    !Object.entries(env).some(
      ([key, value]) =>
        key !== "PRIMARY_DB" &&
        value &&
        typeof value === "object" &&
        typeof (value as CatalogDB).prepare === "function",
    )
  );
}

/**
 * Existing legal and commerce fences protect ALL mutations. The older
 * commerce fence intentionally denies all CTEs; native catalog reads need
 * read-only CTEs. Only the already tested strict QA SELECT/CTE recognizer
 * may route them to the legal-fenced native handle. No raw handle escapes,
 * and CTE statements may not be mixed with writes in a batch.
 */
export function nativeFencedBusinessDb(primary: CatalogDB): CatalogDB {
  const legal = makeStageLegalWriterLock(primary);
  const commerce = commerceRestrictedCanonicalD1(legal);
  type Statement = ReturnType<CatalogDB["prepare"]>;
  const cte = new WeakMap<Statement, Statement>();
  const ordinary = new WeakSet<Statement>();
  const wrapCte = (statement: Statement): Statement => {
    const wrapper: Statement = Object.freeze({
      bind: (...values: unknown[]) => wrapCte(statement.bind(...values)),
      first: <T = unknown>() => statement.first<T>(),
      all: <T = unknown>() => statement.all<T>(),
      run: async () => {
        throw Error("consolidated_cte_write_denied");
      },
    });
    cte.set(wrapper, statement);
    return wrapper;
  };
  const wrapOrdinary = (statement: Statement): Statement => {
    const wrapper: Statement = Object.freeze({
      bind: (...values: unknown[]) => wrapOrdinary(statement.bind(...values)),
      first: <T = unknown>() => statement.first<T>(),
      all: <T = unknown>() => statement.all<T>(),
      run: () => statement.run(),
    });
    ordinary.add(wrapper);
    originals.set(wrapper, statement);
    return wrapper;
  };
  const originals = new WeakMap<Statement, Statement>();
  const sessions = primary as CatalogDB & {
    withSession?: (mode: "first-primary" | "first-unconstrained") => CatalogDB;
  };
  return Object.freeze({
    prepare(sql: string) {
      if (/^\s*WITH\b/i.test(sql)) {
        checkedQaOwnerReadSql(sql);
        return wrapCte(legal.prepare(sql));
      }
      return wrapOrdinary(commerce.prepare(sql));
    },
    batch(statements: Statement[]) {
      if (!Array.isArray(statements) || statements.length < 1 || statements.length > 100)
        throw Error("consolidated_batch_denied");
      if (statements.every((s) => ordinary.has(s)))
        return commerce.batch(statements.map((s) => originals.get(s)!));
      if (statements.every((s) => cte.has(s)))
        return legal.batch(statements.map((s) => cte.get(s)!));
      throw Error("consolidated_mixed_or_foreign_batch_denied");
    },
    ...(typeof sessions.withSession === "function"
      ? {
          withSession(mode: "first-primary" | "first-unconstrained") {
            if (mode !== "first-primary" && mode !== "first-unconstrained")
              throw Error("consolidated_session_denied");
            return nativeFencedBusinessDb(sessions.withSession!(mode));
          },
        }
      : {}),
  });
}

function businessEnv(env: OwnerEnv): BackendEnv {
  if (!enrolled(env)) throw Error("consolidated_qa_owner_not_enrolled");
  const { PRIMARY_DB, ...bindings } = env;
  const db = bindPublicationOwner(nativeFencedBusinessDb(PRIMARY_DB), {
    owner: env.LEGAL_AUTHORITY!.getByName("cove-staged-legal-global-v1"),
    secret: env.COVE_RIGHTS_OWNER_SECRET!,
    territory: "US",
    currency: "USD",
  });
  return {
    ...bindings,
    DB: db,
    COVE_QA_SCHEDULE_OWNER_ENABLED: "0",
    COVE_PUBLICATION_COMMANDS_ENABLED: "0",
  } as BackendEnv;
}

export class CoveBusinessEntrypoint extends WorkerEntrypoint<OwnerEnv> {
  async fetch(request: Request): Promise<Response> {
    if (!enrolled(this.env))
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    // Reuse the original gateway authentication, customer auth, request
    // parsing, routes, streaming response and audit logic. No SQL RPC.
    return backend.fetch(request, businessEnv(this.env), this.ctx);
  }
}

export default {
  fetch: legalAuthority.fetch,
  async scheduled(controller: { cron: string; scheduledTime: number }, env: OwnerEnv) {
    if (!enrolled(env)) throw Error("consolidated_qa_owner_not_enrolled");
    // Retain the existing durable exact-minute claim/replay journal and
    // owner-side domain fences. The original gateway no longer owns a cron.
    const { PRIMARY_DB: _native, ...bindings } = env;
    await dispatchQaOwnerScheduledTick(controller, {
      ...bindings,
      COVE_QA_SCHEDULE_OWNER_ENABLED: "1",
    });
  },
};
