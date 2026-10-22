import type { StorefrontDB } from "./localization-optimized.server";
import {
  produceHomepagePresentation,
  readHomepagePresentation,
  homepagePresentationKey,
} from "./homepage-presentation.server";
import { namespacedPresentationStore } from "./prepared-catalog.server";

type Domain = StorefrontDB;
type Source = Domain & { withSession(constraint: "first-unconstrained"): Domain };
type ObjectMetadata = { etag: string; customMetadata?: Record<string, string> };
type Bucket = {
  head(key: string): Promise<ObjectMetadata | null>;
  put(
    key: string,
    body: string,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
      onlyIf: { etagMatches: string } | { etagDoesNotMatch: string };
    },
  ): Promise<ObjectMetadata | null>;
};
type CommonEnv = {
  DISCOVERY_DB: Domain;
  COVE_PUBLICATION_ENABLED?: string;
  COVE_PRESENTATION_PREFIX: string;
};
export type ExportEnv = CommonEnv & { SOURCE_DB: Source };
export type PublishEnv = CommonEnv & { PRESENTATION: Bucket };
type Job = {
  country: string;
  generation: number;
  attempts: number;
  body: string;
  sha256: string;
  expires_at: number;
};

const MAX_BYTES = 512 * 1024;
const LEASE_MS = 120_000;
const REFRESH_MS = 5 * 60_000;
const MAX_ATTEMPTS = 4;
async function hash(body: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function identity(env: CommonEnv) {
  if (env.COVE_PUBLICATION_ENABLED !== "1") throw Error("publication_disabled");
  // Prefix is an immutable deployment choice, never supplied by a request.
  namespacedPresentationStore(
    {
      async get() {
        return null;
      },
    },
    env.COVE_PRESENTATION_PREFIX,
  );
  if (!env.COVE_PRESENTATION_PREFIX) throw Error("publication_namespace_required");
  const row = await env.DISCOVERY_DB.prepare(
    `SELECT domain,schema_version,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND
      name IN ('products','rights_grants','users','payment_orders','commerce_orders')) contaminated
    FROM discovery_domain_identity WHERE id=1`,
  ).first<{ domain: string; schema_version: number; contaminated: number }>();
  if (row?.domain !== "cove-public-presentation" || row.schema_version !== 1 || row.contaminated)
    throw Error("publication_domain_not_isolated");
}

/** A source session is presentation-only. No mutation, exec, unvalidated batch,
 * primary lease or customer table is available through this adapter. Routing
 * metadata is retained; session eligibility is not called proof of a replica. */
function presentationSource(source: Source, metrics: Record<string, number>) {
  const session = source.withSession("first-unconstrained");
  const statements = new WeakMap<object, object>();
  function record(value: unknown) {
    const result = value as {
      meta?: {
        rows_read?: number;
        served_by_primary?: boolean;
        timings?: { sql_duration_ms?: number };
      };
    };
    metrics.statements++;
    if (result.meta?.served_by_primary === true) metrics.primary++;
    else if (result.meta?.served_by_primary === false) metrics.replica++;
    else metrics.unknown++;
    metrics.rows += result.meta?.rows_read || 0;
    metrics.sqlMs += result.meta?.timings?.sql_duration_ms || 0;
  }
  function prepare(sql: string, values: unknown[] = []) {
    if (
      !/^(SELECT|WITH)\s/i.test(sql.trim()) ||
      /;\s*\S/.test(sql) ||
      /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|users|orders|entitlements|sessions)\b/i.test(
        sql,
      )
    )
      throw Error("publication_source_read_only");
    const raw = session.prepare(sql).bind(...values);
    const wrapped = {
      bind: (...args: unknown[]) => prepare(sql, args),
      async all<T>() {
        try {
          const result = await raw.all<T>();
          record(result);
          return result;
        } catch (error) {
          // Only a failed, validated read-only query may be replayed, once.
          // Publication output is never a legal authority or a side effect.
          // A fresh session avoids reusing a broken D1 transport.
          if (!/\bNetwork connection lost\b/i.test(String(error))) throw error;
          metrics.retries++;
          const retry = source
            .withSession("first-unconstrained")
            .prepare(sql)
            .bind(...values);
          const result = await retry.all<T>();
          record(result);
          return result;
        }
      },
      async first<T>() {
        return (await wrapped.all<T>()).results[0] ?? null;
      },
      async run() {
        throw Error("publication_source_read_only");
      },
    };
    statements.set(wrapped, raw);
    return wrapped;
  }
  return {
    prepare,
    async batch(batch: ReturnType<typeof prepare>[]) {
      if (batch.some((s) => !statements.has(s))) throw Error("publication_unvalidated_batch");
      // D1 batches are ordered. Never fan out independent D1 HTTP calls
      // from a background exporter: they compete with customer rights
      // service on the same source primary when replicas are unavailable.
      const results = [];
      for (const statement of batch) results.push(await statement.all());
      return results;
    },
  } satisfies Domain;
}

async function claim(env: CommonEnv, lane: "export" | "publish", token: string, now: number) {
  await env.DISCOVERY_DB.prepare(
    `UPDATE discovery_publications SET status='delivered',
    attempts=0,lease_token='',lease_until=0,due_at=?,last_error='expired_final_attempt'
    WHERE status IN ('exporting','publishing') AND lease_until<=? AND attempts>=?`,
  )
    .bind(now + REFRESH_MS, now, MAX_ATTEMPTS)
    .run();
  const exporting = lane === "export";
  const state = exporting ? "exporting" : "publishing";
  const waiting = exporting ? "delivered" : "ready";
  return env.DISCOVERY_DB.prepare(
    `UPDATE discovery_publications SET
    status=?,lease_token=?,lease_until=?,attempts=attempts+1,
    generation=generation+CASE WHEN ?='exporting' AND status='delivered' THEN 1 ELSE 0 END
    WHERE country=(SELECT country FROM discovery_publications WHERE active=1
      AND ((status=? AND due_at<=?) OR (status=? AND lease_until<=?))
      AND attempts<? ORDER BY due_at,country LIMIT 1)
    RETURNING country,generation,attempts,body,sha256,expires_at`,
  )
    .bind(state, token, now + LEASE_MS, state, waiting, now, state, now, MAX_ATTEMPTS)
    .first<Job>();
}

async function failed(
  env: CommonEnv,
  job: Job,
  token: string,
  lane: "export" | "publish",
  error: unknown,
) {
  const now = Date.now();
  // At most four attempts per generation. Exhausted exports are rebuilt in
  // the next refresh interval; exhausted/expired publications are discarded.
  const exhausted = job.attempts >= MAX_ATTEMPTS;
  const state = exhausted ? "delivered" : lane === "export" ? "exporting" : "ready";
  const delay = exhausted
    ? REFRESH_MS
    : 15_000 * 2 ** job.attempts + (crypto.getRandomValues(new Uint32Array(1))[0] % 10_000);
  await env.DISCOVERY_DB.prepare(
    `UPDATE discovery_publications SET status=?,
    attempts=CASE WHEN ? THEN 0 ELSE attempts END,due_at=?,lease_until=?,lease_token='',last_error=?
    WHERE country=? AND generation=? AND lease_token=?`,
  )
    .bind(
      state,
      exhausted ? 1 : 0,
      now + delay,
      now + delay,
      String(error).slice(0, 160),
      job.country,
      job.generation,
      token,
    )
    .run();
}

// A publisher owns the independent ledger only. The reserved inactive ZZ row
// acts as an atomic cross-Worker export lease, not a storefront market or a
// production-rights lock. This prevents concurrent scheduled invocations from
// multiplying load against the large source D1.
async function holdExportLease(db: Domain, owner: string, now: number) {
  await db
    .prepare("INSERT OR IGNORE INTO discovery_publications(country,active) VALUES('ZZ',0)")
    .run();
  return db
    .prepare(
      "UPDATE discovery_publications SET lease_token=?,lease_until=? WHERE country='ZZ' AND active=0 AND lease_until<=? RETURNING country",
    )
    .bind(owner, now + LEASE_MS, now)
    .first();
}
async function refreshExportLease(db: Domain, owner: string) {
  const now = Date.now();
  const current = await db
    .prepare(
      "UPDATE discovery_publications SET lease_until=? WHERE country='ZZ' AND active=0 AND lease_token=? AND lease_until>? RETURNING country",
    )
    .bind(now + LEASE_MS, owner, now)
    .first();
  if (!current) throw Error("publication_export_owner_lost");
}
async function releaseExportLease(db: Domain, owner: string) {
  await db
    .prepare(
      "UPDATE discovery_publications SET lease_until=0,lease_token='' WHERE country='ZZ' AND lease_token=?",
    )
    .bind(owner)
    .run();
}

// The production exporter must never scan the canonical rights D1, even if
// D1 read replication is set to auto. A first-unconstrained session is not a
// physical replica guarantee. Require an independently owned, recently synced
// source domain before performing ANY catalog query. The real-source CI fixture
// uses a separate, non-routable stage-only entrypoint to test correctness.
async function assertIndependentPublicationSource(source: Source) {
  let identity: {
    domain?: string;
    last_synced_at?: number;
  } | null = null;
  try {
    identity = await source
      .withSession("first-unconstrained")
      .prepare("SELECT domain,last_synced_at FROM cove_publication_source_identity WHERE id=1")
      .first<{ domain: string; last_synced_at: number }>();
  } catch {
    throw Error("publication_independent_source_required");
  }
  if (
    identity?.domain !== "cove-independent-publication-source" ||
    !Number.isFinite(identity.last_synced_at) ||
    Number(identity.last_synced_at) > Date.now() + 30_000 ||
    Number(identity.last_synced_at) < Date.now() - 120_000
  )
    throw Error("publication_independent_source_stale");
}

/** Max four markets per cron and only one exporter across all Worker isolates.
 * Every export runs outside the customer hot path and snapshots remain untrusted
 * display data; checkout and reader still revalidate the canonical D1. */
export async function exportPublicPresentation(
  env: ExportEnv,
  stageOnly?: { readonly allowCanonicalStageFixture: true },
) {
  await identity(env);
  if (env.SOURCE_DB === env.DISCOVERY_DB) throw Error("publication_source_not_isolated");
  // The production entrypoint never passes this stage-only capability.
  if (!stageOnly?.allowCanonicalStageFixture)
    await assertIndependentPublicationSource(env.SOURCE_DB);
  const owner = crypto.randomUUID();
  const ownsLane = await holdExportLease(env.DISCOVERY_DB, owner, Date.now());
  // Do not even open a source DB session when another exporter owns the lane.
  if (!ownsLane) return { results: [], source: null, skipped: true };
  try {
    const metrics = {
      statements: 0,
      primary: 0,
      replica: 0,
      unknown: 0,
      rows: 0,
      sqlMs: 0,
      retries: 0,
    };
    const source = presentationSource(env.SOURCE_DB, metrics);
    const materialized = !stageOnly?.allowCanonicalStageFixture;
    const markets = materialized
      ? await source
          .prepare(
            "SELECT country FROM cove_publication_source_snapshots WHERE expires_at>? ORDER BY country LIMIT 33",
          )
          .bind(Date.now())
          .all<{ country: string }>()
      : await source
          .prepare(
            "SELECT country_code FROM storefront_markets WHERE market_status='active' ORDER BY country_code LIMIT 33",
          )
          .all<{ country_code: string }>();
    const countries = markets.results.map((m) =>
      materialized ? (m as { country: string }).country : (m as { country_code: string }).country_code,
    );
    if (materialized) {
      const progress = await source
        .prepare("SELECT expected_markets FROM cove_publication_source_progress WHERE id=1")
        .first<{ expected_markets: number }>();
      if (!progress || progress.expected_markets !== countries.length)
        throw Error("publication_incomplete_source_backfill");
    }
    if (!countries.length || countries.length > 32 || countries.some((c) => !/^[A-Z]{2}$/.test(c)))
      throw Error("publication_invalid_markets");
    await env.DISCOVERY_DB.prepare(
      `INSERT OR IGNORE INTO discovery_publications(country)
      SELECT value FROM json_each(?)`,
    )
      .bind(JSON.stringify(countries))
      .run();
    await env.DISCOVERY_DB.prepare(
      `UPDATE discovery_publications SET active=CASE
      WHEN country IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END`,
    )
      .bind(JSON.stringify(countries))
      .run();
    const results = [];
    for (let n = 0; n < 4; n++) {
      const token = crypto.randomUUID(),
        now = Date.now();
      await refreshExportLease(env.DISCOVERY_DB, owner);
      const job = await claim(env, "export", token, now);
      if (!job) break;
      try {
        let body = "";
        let expiresAt = 0;
        if (materialized) {
          const snapshot = await source
            .prepare(
              "SELECT body,sha256,expires_at FROM cove_publication_source_snapshots WHERE country=?",
            )
            .bind(job.country)
            .first<{ body: string; sha256: string; expires_at: number }>();
          if (!snapshot || snapshot.expires_at <= now)
            throw Error("publication_source_snapshot_missing");
          body = snapshot.body;
          expiresAt = snapshot.expires_at;
          if (await hash(body) !== snapshot.sha256)
            throw Error("publication_source_digest_mismatch");
          await readHomepagePresentation(
            {
              async get() {
                return {
                  size: new TextEncoder().encode(body).length,
                  text: async () => body,
                };
              },
            },
            new Request("https://publication.invalid/"),
            job.country,
            now,
          );
        } else {
          const summary = await produceHomepagePresentation(
            source,
            job.country,
            {
              async get() {
                throw Error("export_does_not_read_serving_data");
              },
              async put(_key, value) {
                body = value;
              },
            },
            now,
          );
          expiresAt = summary.expiresAt;
        }
        if (!body || new TextEncoder().encode(body).length > MAX_BYTES)
          throw Error("publication_invalid_body");
        const sha = await hash(body);
        const ack = await env.DISCOVERY_DB.prepare(
          `UPDATE discovery_publications SET
          body=?,sha256=?,expires_at=?,source_metrics=?,status='ready',attempts=0,
          lease_token='',lease_until=0,due_at=?,last_error=''
          WHERE country=? AND generation=? AND lease_token=? AND lease_until>?
          RETURNING country`,
        )
          .bind(
            body,
            sha,
            expiresAt,
            JSON.stringify(metrics),
            Date.now(),
            job.country,
            job.generation,
            token,
            Date.now(),
          )
          .first();
        if (!ack) throw Error("publication_export_lease_lost");
        results.push({ country: job.country, generation: job.generation, exported: true });
      } catch (error) {
        await failed(env, job, token, "export", error);
        results.push({ country: job.country, exported: false });
      }
    }
    return { results, source: metrics, skipped: false };
  } finally {
    await releaseExportLease(env.DISCOVERY_DB, owner);
  }
}

/** This consumer has no source/primary binding. CAS plus generation metadata
 * prevents a delayed/replayed publisher from overwriting newer presentation.
 * The live storefront's authority query remains completely independent. */
export async function publishPublicPresentation(env: PublishEnv) {
  await identity(env);
  const results = [];
  for (let n = 0; n < 4; n++) {
    const token = crypto.randomUUID(),
      job = await claim(env, "publish", token, Date.now());
    if (!job) break;
    try {
      if (
        new TextEncoder().encode(job.body).length > MAX_BYTES ||
        (await hash(job.body)) !== job.sha256
      )
        throw Error("publication_digest_mismatch");
      await readHomepagePresentation(
        {
          async get() {
            return {
              size: new TextEncoder().encode(job.body).length,
              async text() {
                return job.body;
              },
            };
          },
        },
        new Request("https://publication.invalid/"),
        job.country,
      );
      const key = env.COVE_PRESENTATION_PREFIX + homepagePresentationKey(job.country);
      const current = await env.PRESENTATION.head(key);
      const version = Number(current?.customMetadata?.generation || 0);
      if (
        version > job.generation ||
        (version === job.generation && current?.customMetadata?.sha256 !== job.sha256)
      )
        throw Error("publication_generation_conflict");
      const live = await env.DISCOVERY_DB.prepare(
        `SELECT country FROM discovery_publications
        WHERE country=? AND generation=? AND lease_token=? AND status='publishing' AND lease_until>?`,
      )
        .bind(job.country, job.generation, token, Date.now())
        .first();
      if (!live) throw Error("publication_publish_lease_lost");
      if (version !== job.generation) {
        const saved = await env.PRESENTATION.put(key, job.body, {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { generation: String(job.generation), sha256: job.sha256 },
          onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
        });
        if (!saved) throw Error("publication_compare_and_swap_failed");
      }
      const ack = await env.DISCOVERY_DB.prepare(
        `UPDATE discovery_publications SET status='delivered',
        attempts=0,lease_token='',lease_until=0,due_at=?,published_at=?,last_error=''
        WHERE country=? AND generation=? AND lease_token=? AND lease_until>? RETURNING country`,
      )
        .bind(Date.now() + REFRESH_MS, Date.now(), job.country, job.generation, token, Date.now())
        .first();
      if (!ack) throw Error("publication_publish_ack_lost");
      results.push({ country: job.country, generation: job.generation, published: true });
    } catch (error) {
      await failed(env, job, token, "publish", error);
      results.push({ country: job.country, published: false });
    }
  }
  return results;
}
