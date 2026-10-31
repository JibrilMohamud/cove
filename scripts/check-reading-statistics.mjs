import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

// Auth headers only exist in this isolated harness; production never trusts client versions.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-reading-stats-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    // Bundle the API and its owner facade together so their private WeakMap
    // identity is the same as in production. Never duplicate the owner module.
    stdin: {
      contents: `export {handleCoveApi} from "./src/features/fore/api.server.ts";
export {bindPublicationOwner,hasPublicationOwner,dispatchVerifiedFreeLibraryEntitlement} from "./src/storefront-strangler/publication-owner-routing.server.ts";`,
      resolveDir: process.cwd(),
      sourcefile: "statistics-qa-owner-entry.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "api.mjs"),
    logLevel: "silent",
  });
  const { handleCoveApi, bindPublicationOwner, hasPublicationOwner, dispatchVerifiedFreeLibraryEntitlement } = await import(path.join(root, "api.mjs"));
  let env = localBindings(root);
  const db = env.DB,
    alice = "statistics-alice",
    bob = "statistics-bob",
    at = new Date().toISOString();
  async function request(user, route, method = "GET", body) {
    const response = await handleCoveApi(
      new Request("https://fore.test/api/fore" + route, {
        method,
        headers: {
          origin: "https://fore.test",
          "content-type": "application/json",
          "oai-authenticated-user-id": user,
          "oai-authenticated-user-email": user + "@example.test",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
    return { status: response.status, data: await response.json() };
  }
  const run = (sql, ...args) =>
    db
      .prepare(sql)
      .bind(...args)
      .run();
  await request(alice, "/profile", "POST", { name: "Statistics Alice" });
  await request(bob, "/profile", "POST", { name: "Statistics Bob" });
  await request(alice, "/catalog?q=pride");
  const product = await db
    .prepare("SELECT id,public_id,edition_id FROM products WHERE source_external_id='1342'")
    .first();
  assert.ok(product?.public_id, "canonical product must expose a Cove public ID");
  // Missing legal authority must DENY even a free-library write. Use an
  // isolated, explicitly synthetic owner to exercise the subsequent reader
  // statistics integration without asserting production legal rights.
  const denied = await request(alice, "/library", "POST", {
    bookId: product.public_id,
    status: "finished",
    progress: 1,
  });
  assert.equal(denied.status, 503, "Unbound free-library entitlement must fail closed");
  const ownerSecret = "a".repeat(64);
  const owner = {
    async fetch(ownerRequest) {
      assert.equal(ownerRequest.method, "POST");
      if (new URL(ownerRequest.url).pathname !== "/catalog/private-grant-free-library")
        return new Response(null, { status: 404 });
      if (ownerRequest.headers.get("authorization") !== "Bearer " + ownerSecret)
        return new Response(null, { status: 401 });
      const claim = await ownerRequest.json();
      if (
        claim.userId !== alice ||
        claim.productId !== String(product.id) ||
        claim.territory !== "US"
      ) return new Response(null, { status: 409 });
      const persisted = await db.prepare(
        "SELECT id FROM products WHERE id=? AND source_name='gutenberg' AND source_external_id='1342'"
      ).bind(claim.productId).first();
      if (!persisted) return new Response(null, { status: 409 });
      return Response.json({
        schema: "cove.owner-free-library-entitlement.v1",
        ownerFirst: true, saved: true,
        userId: claim.userId, productId: claim.productId,
      });
    },
  };
  env = {
    ...env,
    DB: bindPublicationOwner(db, {
      owner, secret: ownerSecret, territory: "US", currency: "USD",
    }),
  };

  assert.equal(hasPublicationOwner(env.DB),true,"Synthetic private legal owner must be bound to exactly this D1 facade");
  await dispatchVerifiedFreeLibraryEntitlement(env.DB,{
    userId:alice,productId:String(product.id),territory:"US"
  });
  const metrics = await request(alice, "/metrics", "PUT", {
    bookId: product.public_id,
    wordCount: 119999,
    readingLevel: 7.5,
    language: "en",
  });
  assert.equal(metrics.status, 200, JSON.stringify(metrics));
  const normalized = await db
    .prepare("SELECT book_id FROM book_metrics WHERE user_id=?")
    .bind(alice)
    .first();
  assert.equal(
    normalized.book_id,
    "1342",
    "public metric IDs must normalize to external source IDs",
  );
  // Exercise backward compatibility with metrics written by older clients.
  await run("DELETE FROM book_metrics WHERE user_id=?", alice);
  await run(
    "INSERT INTO book_metrics(user_id,book_id,word_count,reading_level,language,method,updated_at) VALUES(?,?,?,?,?,'legacy',?)",
    alice,
    product.public_id,
    119999,
    7.5,
    "en",
    at,
  );
  await run(
    "INSERT OR IGNORE INTO categories(id,scheme,name) VALUES('category_stats','gutenberg-bookshelf','Category: Fiction')",
  );
  await run(
    "INSERT OR IGNORE INTO edition_categories(edition_id,category_id,position) VALUES(?,'category_stats',0)",
    product.edition_id,
  );
  const finish = await request(alice, "/library", "POST", {
    bookId: product.public_id,
    status: "finished",
    progress: 1,
  });
  assert.equal(finish.status, 200, JSON.stringify(finish));
  const finishedAgain = await request(alice, "/library", "POST", {
    bookId: product.public_id,
    status: "finished",
    progress: 1,
  });
  assert.equal(finishedAgain.status, 200, JSON.stringify(finishedAgain));
  const complete = await request(alice, "/stats?days=30&timeZone=America%2FNew_York");
  assert.equal(complete.status, 200, JSON.stringify(complete));
  assert.equal(complete.data.totals.finished, 1, "repeated completion must not double count");
  assert.equal(complete.data.totals.measuredBooks, 1, "legacy public ID metrics must join");
  assert.equal(complete.data.totals.averageBookWords, 119999);
  assert.equal(complete.data.totals.averageReadingLevel, 7.5);
  assert.ok(
    complete.data.genres.some((genre) => genre.name === "Fiction"),
    "current Category labels must appear in genre breakdowns",
  );
  const zone = "America/New_York",
    dayFormat = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
    day = (time) => {
      const parts = dayFormat.formatToParts(new Date(time));
      const part = (type) => parts.find((p) => p.type === type).value;
      return `${part("year")}-${part("month")}-${part("day")}`;
    };
  let boundary = null;
  for (let cursor = Date.now() - 120000; cursor > Date.now() - 172800000; cursor -= 60000) {
    if (day(cursor - 60000) !== day(cursor)) {
      let low = cursor - 60000,
        high = cursor;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (day(mid) === day(low)) low = mid;
        else high = mid;
      }
      boundary = high;
      break;
    }
  }
  assert.ok(boundary, "found recent local midnight");
  const recent = {
    id: randomUUID(),
    bookId: "1342",
    mode: "read",
    startedAt: new Date(boundary - 60000).toISOString(),
    endedAt: new Date(boundary + 60000).toISOString(),
    activeSeconds: 120,
    wordsRead: 240,
  };
  assert.equal((await request(alice, "/sessions", "PUT", recent)).status, 200);
  const local = await request(alice, "/stats?days=7&timeZone=America%2FNew_York");
  assert.equal(local.status, 200, JSON.stringify(local));
  const before = local.data.daily.find((d) => d.date === day(boundary - 60000)),
    after = local.data.daily.find((d) => d.date === day(boundary + 60000));
  assert.ok(before && after, "midnight-crossing session must occupy two local dates");
  assert.ok(Math.abs(before.read_seconds - 60) < 0.01, JSON.stringify(local.data.daily));
  assert.ok(Math.abs(after.read_seconds - 60) < 0.01, JSON.stringify(local.data.daily));
  assert.equal(local.data.totals.readSeconds, 120);
  assert.equal(local.data.range.timeZone, zone);
  assert.equal((await request(alice, "/stats?days=7&timeZone=Definitely%2FNotAZone")).status, 400);
  // Spring DST advances from EST to EDT: the clock skips an hour but actual seconds must not.
  await run(
    "INSERT INTO reading_sessions(id,user_id,book_id,mode,started_at,ended_at,active_seconds,words_read) VALUES(?,?,?,?,?,?,?,?)",
    randomUUID(),
    alice,
    "1342",
    "listen",
    "2026-03-08T04:30:00.000Z",
    "2026-03-08T07:30:00.000Z",
    10800,
    0,
  );
  const historical = await request(alice, "/stats?days=all&timeZone=America%2FNew_York");
  assert.equal(historical.status, 200, JSON.stringify(historical));
  assert.ok(
    Math.abs(historical.data.daily.find((d) => d.date === "2026-03-07").listen_seconds - 1800) <
      0.01,
  );
  assert.ok(
    Math.abs(historical.data.daily.find((d) => d.date === "2026-03-08").listen_seconds - 9000) <
      0.01,
  );

  // An unlinked commercial edition is valid without a Gutenberg audio_editions row.
  await run(
    "INSERT INTO publishing_accounts(id,account_type,legal_name,display_name,country_code,created_at,updated_at) VALUES('stats_publisher','person','Test Publisher','Test Publisher','US',?,?)",
    at,
    at,
  );
  await run(
    "INSERT INTO publishing_titles(id,account_id,title,created_at,updated_at) VALUES('stats_title','stats_publisher','Audio sample',?,?)",
    at,
    at,
  );
  await run(
    "INSERT INTO publishing_edition_drafts(id,title_id,format,status,catalog_product_id,created_at,updated_at) VALUES('stats_audio','stats_title','audiobook','published',?,?,?)",
    product.id,
    at,
    at,
  );
  await run(
    "INSERT INTO commercial_audio_profiles(edition_id,publishing_account_id,active_policy_id,updated_at,created_at) VALUES('stats_audio','stats_publisher','audiopol_fore_commercial_audio_v1',?,?)",
    at,
    at,
  );
  const audioSession = {
    id: randomUUID(),
    bookId: "ca_stats_audio",
    mode: "listen",
    startedAt: new Date(Date.now() - 120000).toISOString(),
    endedAt: new Date(Date.now() - 2000).toISOString(),
    activeSeconds: 100,
    wordsRead: 0,
  };
  const noAccess = await request(bob, "/sessions", "PUT", audioSession);
  assert.equal(noAccess.status, 403, JSON.stringify(noAccess));
  await run(
    "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at) VALUES(?,?,?,'purchase','active','test',?,?)",
    randomUUID(),
    alice,
    product.id,
    at,
    at,
  );
  const audioSaved = await request(alice, "/sessions", "PUT", audioSession);
  assert.equal(audioSaved.status, 200, JSON.stringify(audioSaved));
  assert.equal((await request(alice, "/sessions", "PUT", audioSession)).status, 200);
  const recorded = await db
    .prepare("SELECT book_id FROM reading_sessions WHERE user_id=? AND id=?")
    .bind(alice, audioSession.id)
    .first();
  assert.equal(recorded.book_id, "1342", "commercial sessions use canonical source identity");
  const totals = await request(alice, "/stats?days=30&timeZone=America%2FNew_York");
  assert.equal(totals.status, 200, JSON.stringify(totals));
  assert.equal(totals.data.totals.sessions, 2, "repeat saves must be idempotent");
  assert.equal(totals.data.totals.listenSeconds, 100);
  console.log(
    "PASS: public metrics, legacy joins, category genres, midnight/DST apportionment, commercial sessions, access control and idempotency",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
