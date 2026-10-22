import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-publication-"));
const ledger = new DatabaseSync(":memory:");
const realNow = Date.now;
let clock = realNow();
try {
  ledger.exec(fs.readFileSync("infra/discovery/0001_publication_feed.sql", "utf8"));
  fs.cpSync("drizzle", path.join(dir, "drizzle"), { recursive: true });
  await build({
    entryPoints: {
      feed: "src/storefront-strangler/publication-feed.server.ts",
      api: "src/features/fore/api.server.ts",
      presentation: "src/storefront-strangler/homepage-presentation.server.ts",
    },
    outdir: dir,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { exportPublicPresentation: exportFeed, publishPublicPresentation: publish } = await import(
    path.join(dir, "feed.js")
  );
  const {
    readHomepagePresentation: read,
    authorizeHomepagePresentation: authorize,
    homepagePresentationKey: key,
  } = await import(path.join(dir, "presentation.js"));
  const { handleCoveApi } = await import(path.join(dir, "api.js"));
  const primary = localBindings(dir);
  const initial = await handleCoveApi(new Request("https://test/api/fore/storefront/bootstrap"), {
    ...primary,
    FORE_ENVIRONMENT: "development",
  });
  assert.equal(initial.status, 200, await initial.text());
  await primary.DB.prepare(
    "UPDATE storefront_markets SET market_status='paused' WHERE country_code NOT IN ('US','CA','SA','JP')",
  ).run();
  const sourceSql = [];
  let sessions = 0;
  const SOURCE_DB = {
    ...primary.DB,
    withSession(constraint) {
      assert.equal(constraint, "first-unconstrained");
      sessions++;
      return {
        ...primary.DB,
        prepare(sql) {
          sourceSql.push(sql);
          assert.match(sql.trim(), /^(SELECT|WITH)\b/i);
          return primary.DB.prepare(sql);
        },
      };
    },
  };
  let loseAck = false;
  const DISCOVERY_DB = {
    prepare(sql) {
      function stmt(values = []) {
        return {
          bind(...args) {
            return stmt(args);
          },
          async first() {
            if (loseAck && sql.includes("published_at=?")) {
              loseAck = false;
              throw Error("lost_ack");
            }
            return ledger.prepare(sql).get(...values) ?? null;
          },
          async all() {
            return { results: ledger.prepare(sql).all(...values) };
          },
          async run() {
            return ledger.prepare(sql).run(...values);
          },
        };
      }
      return stmt();
    },
    async batch() {
      throw Error("not required");
    },
  };
  const objects = new Map();
  let puts = 0,
    conflict = false;
  const PRESENTATION = {
    async head(k) {
      return objects.get(k) ?? null;
    },
    async get(k) {
      const o = objects.get(k);
      return o
        ? {
            size: Buffer.byteLength(o.body),
            async text() {
              return o.body;
            },
          }
        : null;
    },
    async put(k, body, opts) {
      if (conflict) {
        conflict = false;
        return null;
      }
      const old = objects.get(k);
      if (
        (opts.onlyIf.etagMatches && old?.etag !== opts.onlyIf.etagMatches) ||
        (opts.onlyIf.etagDoesNotMatch === "*" && old)
      )
        return null;
      puts++;
      const o = {
        body,
        etag: createHash("sha256").update(body).digest("hex"),
        customMetadata: opts.customMetadata,
      };
      objects.set(k, o);
      return o;
    },
  };
  const base = {
    DISCOVERY_DB,
    COVE_PUBLICATION_ENABLED: "1",
    COVE_PRESENTATION_PREFIX: "feed/test/",
  };
  Date.now = () => clock;
  const exported = await exportFeed({ ...base, SOURCE_DB });
  assert.equal(exported.results.length, 4, JSON.stringify(exported));
  assert.ok(
    exported.results.every((r) => r.exported),
    JSON.stringify(ledger.prepare("SELECT country,last_error FROM discovery_publications").all()),
  );
  assert.equal(puts, 0, "source exporter cannot publish");
  assert.equal(sessions, 1);
  assert.ok(exported.source.statements > 4);
  assert.equal(
    exported.source.unknown,
    exported.source.statements,
    "unknown routing must not be called replica",
  );
  // Two concurrent exporters cannot claim already-ready generations.
  assert.equal((await exportFeed({ ...base, SOURCE_DB })).results.length, 0);
  const pub = await publish({ ...base, PRESENTATION });
  assert.equal(pub.length, 4);
  assert.ok(
    pub.every((r) => r.published),
    JSON.stringify(ledger.prepare("SELECT country,last_error FROM discovery_publications").all()),
  );
  assert.equal(puts, 4);
  const request = new Request("https://test/", { headers: { "accept-language": "en-US" } });
  const scoped = { get: (k) => PRESENTATION.get(base.COVE_PRESENTATION_PREFIX + k) };
  const snapshot = await read(scoped, request, "US", clock);
  const id = snapshot.candidates.productIds[0];
  assert.ok(id);
  assert.ok(
    snapshot.displayBooks.every(
      (b) => !b.offer && !b.subscriptionEligible && !b.formats["application/epub+zip"],
    ),
  );
  await primary.DB.prepare(
    "UPDATE rights_grants SET status='revoked' WHERE edition_id=(SELECT edition_id FROM products WHERE id=?) AND decision='allow'",
  )
    .bind(id)
    .run();
  const books = await authorize(primary.DB, snapshot);
  assert.ok(
    !books.results.some((b) => b.productId === id),
    "publication never preserves a revoked primary grant",
  );
  // Actual source changes are picked up by a full bounded rebuild, rather
  // than relying on a manually seeded fixture or every mutation site.
  await primary.DB.prepare(
    "UPDATE editions SET title='Updated live source title' WHERE id=(SELECT edition_id FROM products WHERE id=?)",
  )
    .bind(snapshot.candidates.productIds[1])
    .run();
  ledger.prepare("UPDATE discovery_publications SET due_at=0 WHERE country='US'").run();
  await exportFeed({ ...base, SOURCE_DB });
  loseAck = true;
  const replay = await publish({ ...base, PRESENTATION });
  assert.equal(replay[0].published, false);
  const written = puts;
  clock += 70_000;
  const retried = await publish({ ...base, PRESENTATION });
  assert.equal(retried[0].published, true);
  assert.equal(puts, written, "lost ACK replay must not rewrite the published generation");
  const refreshed = await read(scoped, request, "US", clock);
  assert.ok(refreshed.displayBooks.some((b) => b.title === "Updated live source title"));
  // A stale CAS does not count as publication; subsequent replay can finish.
  ledger.prepare("UPDATE discovery_publications SET due_at=0 WHERE country='US'").run();
  await exportFeed({ ...base, SOURCE_DB });
  conflict = true;
  assert.equal((await publish({ ...base, PRESENTATION }))[0].published, false);
  clock += 70_000;
  assert.equal((await publish({ ...base, PRESENTATION }))[0].published, true);
  // Final-attempt crashes are recovered, with bounded rebuilding delay.
  ledger
    .prepare(
      "UPDATE discovery_publications SET status='publishing',attempts=4,lease_until=0 WHERE country='US'",
    )
    .run();
  await publish({ ...base, PRESENTATION });
  const recovered = ledger
    .prepare("SELECT status,attempts,due_at FROM discovery_publications WHERE country='US'")
    .get();
  assert.equal(recovered.status, "delivered");
  assert.equal(recovered.attempts, 0);
  assert.ok(recovered.due_at > clock);
  // Expired payloads, malformed digests and contaminated DBs fail closed.
  ledger
    .prepare(
      "UPDATE discovery_publications SET status='ready',attempts=0,due_at=0,body='{}' WHERE country='US'",
    )
    .run();
  const before = puts;
  assert.equal((await publish({ ...base, PRESENTATION }))[0].published, false);
  assert.equal(puts, before);
  await assert.rejects(() => read(scoped, request, "US", clock + 20 * 60_000));
  await assert.rejects(() => exportFeed({ ...base, SOURCE_DB, COVE_PUBLICATION_ENABLED: "0" }));
  await assert.rejects(() => exportFeed({ ...base, SOURCE_DB, COVE_PRESENTATION_PREFIX: "../" }));
  ledger.exec("CREATE TABLE rights_grants(id TEXT)");
  await assert.rejects(() => publish({ ...base, PRESENTATION }));
  assert.ok(sourceSql.every((sql) => !/\b(INSERT|UPDATE|DELETE|CREATE|DROP)\b/i.test(sql)));
  console.log(
    "PASS: live source refresh, independent publication ledger, bounded export, fresh primary revocation, conditional publication, lost ACK replay, crash recovery, expiry and contamination rejection.",
  );
} finally {
  Date.now = realNow;
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
