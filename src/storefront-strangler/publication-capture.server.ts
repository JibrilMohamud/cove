import {
  requestPublicationSource,
  type PublicationSourcePort,
} from "./publication-source-protocol";
import { produceHomepagePresentation } from "./homepage-presentation.server";
import type { StorefrontDB } from "./localization-optimized.server";

// Production capture has only the independent snapshot D1 and a bounded
// private advisory reader. The direct source binding is for legacy QA.
type CanonicalDB = StorefrontDB & {
  withSession(constraint: "first-unconstrained"): StorefrontDB;
};
type SnapshotDB = StorefrontDB;
export type CaptureEnv = {
  SOURCE_DB?: CanonicalDB;
  SOURCE_READER?: PublicationSourcePort;
  COVE_PUBLICATION_SOURCE_READER_SECRET?: string;
  PUBLIC_SOURCE_DB: SnapshotDB;
  COVE_PUBLICATION_CAPTURE_ENABLED?: string;
};
const MAX_BYTES = 512 * 1024;
const LEASE_MS = 120_000;
const PER_RUN = 2;
const enc = new TextEncoder();

async function digest(body: string) {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(body)));
  return [...value].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function checkedSource(db: CanonicalDB): StorefrontDB {
  // Reopen only *read-only* source statements after a reported D1 transport
  // loss. A new session is essential: retrying the broken sticky connection
  // simply repeats the same error. Never replay writes, rights decisions or
  // downstream publication acknowledgements.
  const session = db.withSession("first-unconstrained");
  function prepare(sql: string, args: unknown[] = []) {
    if (
      !/^(SELECT|WITH)\s/i.test(sql.trim()) ||
      /;\s*\S|\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|users|orders|entitlements|sessions)\b/i.test(
        sql,
      )
    )
      throw Error("capture_canonical_read_only");
    const stmt = session.prepare(sql).bind(...args);
    const all = async <T>() => {
      try {
        return await stmt.all<T>();
      } catch (error) {
        if (!/\bNetwork connection lost\b/i.test(String(error))) throw error;
        console.warn(
          JSON.stringify({ event: "capture_source_read_retry", reason: "d1_connection_lost" }),
        );
        return db
          .withSession("first-unconstrained")
          .prepare(sql)
          .bind(...args)
          .all<T>();
      }
    };
    return {
      bind: (...next: unknown[]) => prepare(sql, next),
      all,
      async first<T>() {
        return (await all<T>()).results[0] ?? null;
      },
      async run() {
        throw Error("capture_canonical_read_only");
      },
    };
  }
  return {
    prepare,
    // Statements are ordered and bounded, never executed in parallel against
    // the primary; this avoids a full fan-out during source refresh.
    async batch(statements: ReturnType<StorefrontDB["prepare"]>[]) {
      const results = [];
      for (const stmt of statements) results.push(await stmt.all());
      return results;
    },
  };
}

export async function capturePublicSource(env: CaptureEnv) {
  if (env.COVE_PUBLICATION_CAPTURE_ENABLED !== "1") throw Error("capture_disabled");
  if (env.PUBLIC_SOURCE_DB === env.SOURCE_DB) throw Error("capture_source_must_be_isolated");
  const sourceTables = await env.PUBLIC_SOURCE_DB.prepare(
    "SELECT domain FROM cove_publication_source_identity WHERE id=1",
  ).first<{ domain: string }>();
  if (sourceTables && sourceTables.domain !== "cove-independent-publication-source")
    throw Error("capture_source_domain_conflict");
  const owner = crypto.randomUUID();
  const started = Date.now();
  const locked = await env.PUBLIC_SOURCE_DB.prepare(
    "UPDATE cove_publication_source_progress SET owner=?,lease_until=? WHERE id=1 AND lease_until<=? RETURNING cursor,expected_markets",
  )
    .bind(owner, started + LEASE_MS, started)
    .first<{ cursor: string; expected_markets: number }>();
  if (!locked) return { busy: true, countries: [] };
  const countries: string[] = [];
  try {
    if (env.SOURCE_READER && env.SOURCE_DB) throw Error("capture_ambiguous_source_capability");
    if (!env.SOURCE_READER && !env.SOURCE_DB) throw Error("capture_source_missing");
    const canonical = env.SOURCE_READER ? null : checkedSource(env.SOURCE_DB!);
    const privateSource = env.SOURCE_READER
      ? await requestPublicationSource(
          env.SOURCE_READER,
          env.COVE_PUBLICATION_SOURCE_READER_SECRET || "",
        )
      : null;
    const active = canonical
      ? await canonical
          .prepare(
            "SELECT country_code FROM storefront_markets WHERE market_status='active' ORDER BY country_code LIMIT 33",
          )
          .all<{ country_code: string }>()
      : { results: privateSource!.countries!.map((country_code) => ({ country_code })) };
    const markets = active.results.map((x) => x.country_code);
    if (!markets.length || markets.length > 32 || markets.some((x) => !/^[A-Z]{2}$/.test(x)))
      throw Error("capture_market_config_invalid");
    // A removed market must not strand a never-completing backfill. This
    // changes only the separate public snapshot source, never canonical D1.
    await env.PUBLIC_SOURCE_DB.prepare(
      "DELETE FROM cove_publication_source_snapshots WHERE country NOT IN (SELECT value FROM json_each(?))",
    )
      .bind(JSON.stringify(markets))
      .run();
    // A cursor is deterministic across crashes; already committed markets
    // can safely be captured again. Each invocation does at most two markets.
    const previous = locked.cursor || "";
    const following = markets.findIndex((x) => x > previous);
    let position = following < 0 ? 0 : following;
    for (let n = 0; n < Math.min(PER_RUN, markets.length); n++) {
      const country = markets[position];
      const now = Date.now();
      let body = "";
      const remote = env.SOURCE_READER
        ? await requestPublicationSource(
            env.SOURCE_READER,
            env.COVE_PUBLICATION_SOURCE_READER_SECRET || "",
            country,
          )
        : null;
      if (remote) body = remote.body!;
      const snapshot = remote
        ? { expiresAt: remote.expiresAt! }
        : await produceHomepagePresentation(
            canonical!,
            country,
            {
              async get() {
                throw Error("capture_does_not_read_serving_r2");
              },
              async put(_key, value) {
                body = value;
              },
            },
            now,
          );
      if (!body || enc.encode(body).length > MAX_BYTES || snapshot.expiresAt <= now)
        throw Error("capture_invalid_snapshot");
      const sha = await digest(body);
      // Both the body and its digest are stored atomically as one D1 row.
      // Publication verifies it independently before writing private R2.
      const wrote = await env.PUBLIC_SOURCE_DB.prepare(
        `INSERT INTO cove_publication_source_snapshots(country,generation,body,sha256,created_at,expires_at)
         SELECT ?,1,?,?,?,?
         WHERE EXISTS(SELECT 1 FROM cove_publication_source_progress
                      WHERE id=1 AND owner=? AND lease_until>?)
         ON CONFLICT(country) DO UPDATE SET
           generation=generation+1,body=excluded.body,sha256=excluded.sha256,
           created_at=excluded.created_at,expires_at=excluded.expires_at`,
      )
        .bind(country, body, sha, now, snapshot.expiresAt, owner, Date.now())
        .run();
      if (wrote.meta?.changes !== 1) throw Error("capture_lease_lost");
      const endOfCycle = position === markets.length - 1;
      const acknowledged = await env.PUBLIC_SOURCE_DB.prepare(
        "UPDATE cove_publication_source_progress SET cursor=?,expected_markets=?,last_full_cycle_at=CASE WHEN ? THEN ? ELSE last_full_cycle_at END WHERE id=1 AND owner=? AND lease_until>? RETURNING id",
      )
        .bind(country, markets.length, endOfCycle ? 1 : 0, now, owner, Date.now())
        .first<{ id: number }>();
      if (!acknowledged) throw Error("capture_lease_lost");
      countries.push(country);
      position = (position + 1) % markets.length;
    }
    const coverage = await env.PUBLIC_SOURCE_DB.prepare(
      "SELECT COUNT(*) n,MIN(expires_at) min_expiry FROM cove_publication_source_snapshots",
    ).first<{ n: number; min_expiry: number }>();
    // Freshness marker only becomes active after a complete 23-market (or
    // current configuration) backfill; no partial data becomes authoritative.
    if (coverage?.n === markets.length && coverage.min_expiry > Date.now()) {
      await env.PUBLIC_SOURCE_DB.prepare(
        `INSERT INTO cove_publication_source_identity(id,domain,last_synced_at)
         VALUES(1,'cove-independent-publication-source',?)
         ON CONFLICT(id) DO UPDATE SET last_synced_at=excluded.last_synced_at`,
      )
        .bind(Date.now())
        .run();
    }
    return {
      busy: false,
      countries,
      expected: markets.length,
      complete: coverage?.n === markets.length,
    };
  } finally {
    await env.PUBLIC_SOURCE_DB.prepare(
      "UPDATE cove_publication_source_progress SET owner='',lease_until=0 WHERE id=1 AND owner=?",
    )
      .bind(owner)
      .run();
  }
}
