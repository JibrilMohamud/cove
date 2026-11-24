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
    (!env.STRIPE_SECRET_KEY || /^(?:sk|rk|rkcs)_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY)) &&
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
 * and every non-CTE statement is independently checked by both fences.
 */
export function nativeFencedBusinessDb(primary: CatalogDB): CatalogDB {
  const legal = makeStageLegalWriterLock(primary);
  const commerce = commerceRestrictedCanonicalD1(legal);
  type Statement = ReturnType<CatalogDB["prepare"]>;
  // Every statement has a legal-fenced native representation. Non-CTE
  // statements are also admitted through the unchanged commerce gate before
  // preparation. A batch of SELECTs and read-only CTEs therefore executes
  // atomically on ONE native session, not in separate driver batches.
  const issued = new WeakMap<Statement, { statement: Statement; readOnly: boolean }>();
  const wrap = (statement: Statement, readOnly: boolean): Statement => {
    const wrapper: Statement = Object.freeze({
      bind: (...values: unknown[]) => wrap(statement.bind(...values), readOnly),
      first: <T = unknown>() => statement.first<T>(),
      all: <T = unknown>() => statement.all<T>(),
      run: async () => {
        if (readOnly) throw Error("consolidated_read_run_denied");
        return statement.run();
      },
    });
    issued.set(wrapper, { statement, readOnly });
    return wrapper;
  };
  const sessions = primary as CatalogDB & {
    withSession?: (mode: "first-primary" | "first-unconstrained") => CatalogDB;
  };
  return Object.freeze({
    prepare(sql: string) {
      const isCte = /^\s*WITH\b/i.test(sql);
      if (isCte) {
        checkedQaOwnerReadSql(sql);
      } else {
        // Admission only: this creates a prepared handle, never executes it.
        // Keep the commerce and legal checks on every non-CTE statement.
        commerce.prepare(sql);
      }
      return wrap(legal.prepare(sql), isCte || /^\s*SELECT\b/i.test(sql));
    },
    batch(statements: Statement[]) {
      if (!Array.isArray(statements) || statements.length < 1 || statements.length > 100)
        throw Error("consolidated_batch_denied");
      const checked = statements.map((statement) => {
        const entry = issued.get(statement);
        if (!entry) throw Error("consolidated_foreign_batch_denied");
        return entry;
      });
      // The CTE recognizer admits only read-only SQL, and every ordinary
      // statement has already passed BOTH unchanged domain fences. Do not
      // split a source-controlled atomic batch or admit foreign handles.
      return legal.batch(checked.map(({ statement }) => statement));
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
