import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
import { loadAccountOwnerTestClient } from "./test-private-account-client.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-restore-test-"));
let accountOwner;
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/api.server.ts", "src/features/fore/notifications.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const api = await import(path.join(root, "api.server.mjs"));
  const notifications = await import(path.join(root, "notifications.server.mjs"));
  const env = localBindings(root);
  const user = "restore-alice";
  accountOwner = await loadAccountOwnerTestClient(root);
  await env.DB.prepare(
    "INSERT INTO auth_accounts(provider_id,app_id,email,created_at) VALUES(?,?,?,?)",
  )
    .bind(user, user, user + "@example.test", new Date().toISOString())
    .run();
  async function request(route, method = "GET", payload) {
    const handler = route.startsWith("/account/device/")
      ? accountOwner.handleCoveApi
      : api.handleCoveApi;
    const response = await handler(
      new Request("https://fore.test/api/fore" + route, {
        method,
        headers: {
          origin: "https://fore.test",
          "content-type": "application/json",
          "oai-authenticated-user-id": user,
          "oai-authenticated-user-email": user + "@example.test",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }),
      env,
    );
    return { status: response.status, body: await response.json() };
  }
  await request("/catalog?q=pride");
  await request("/profile", "POST", { name: "Restore Alice" });
  const product = await env.DB.prepare(
    "SELECT id,public_id FROM products WHERE source_external_id='1342'",
  ).first();
  assert.ok(product);
  // A commercial offline license cannot be issued from an unregistered
  // browser, nor can a registered browser bypass a publisher's catalog rights.
  const signingPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  env.FORE_OFFLINE_AUDIO_SIGNING_JWK = JSON.stringify(
    await crypto.subtle.exportKey("jwk", signingPair.privateKey),
  );
  const deviceKey = randomUUID() + randomUUID();
  const notRegistered = await request("/offline-epub/license", "POST", {
    productId: product.id,
    deviceKey,
  });
  assert.equal(notRegistered.status, 428, JSON.stringify(notRegistered));
  const registered = await request("/account/device/register", "POST", {
    deviceKey,
    name: "Test reader",
    platform: "Browser",
  });
  assert.equal(registered.status, 200, JSON.stringify(registered));
  const noCommercialGrant = await request("/offline-epub/license", "POST", {
    productId: product.id,
    deviceKey,
  });
  assert.notEqual(noCommercialGrant.status, 201, "Public books must not mint commercial licenses");
  const annotationId = randomUUID();
  const backup = {
    schema: "fore-account-export",
    version: 4,
    reading: {
      states: [
        {
          external_book_id: "1342",
          status: "finished",
          progress: 1,
          cfi: "epubcfi(/6/2!)",
          updated_at: new Date().toISOString(),
        },
      ],
      annotations: [
        {
          id: annotationId,
          book_id: "1342",
          quote: "A restored passage",
          cfi: "epubcfi(/6/2!)",
          chapter: "Chapter One",
          color: "yellow",
          note: "Restore test",
          created_at: new Date().toISOString(),
        },
      ],
      definitions: [],
      sessions: [],
      bookMetrics: [{ book_id: "1342", word_count: 10000, reading_level: 7, language: "en" }],
      goals: [{ year: new Date().getUTCFullYear(), books: 15 }],
    },
  };
  const before = await request("/account/restore", "POST", { dryRun: true, backup });
  assert.equal(before.status, 200, JSON.stringify(before));
  assert.equal(before.body.eligible, 5);
  assert.equal(
    (
      await env.DB.prepare("SELECT COUNT(*) count FROM annotations WHERE user_id=?")
        .bind(user)
        .first()
    ).count,
    0,
  );
  const confirmRequired = await request("/account/restore", "POST", { dryRun: false, backup });
  assert.equal(confirmRequired.status, 400);
  const restored = await request("/account/restore", "POST", {
    dryRun: false,
    confirm: true,
    backup,
  });
  assert.equal(restored.status, 200, JSON.stringify(restored));
  assert.equal(
    (
      await env.DB.prepare("SELECT COUNT(*) count FROM annotations WHERE user_id=?")
        .bind(user)
        .first()
    ).count,
    1,
  );
  assert.equal(
    (
      await env.DB.prepare("SELECT status FROM reading_states WHERE user_id=? AND product_id=?")
        .bind(user, product.id)
        .first()
    ).status,
    "finished",
  );
  assert.equal(
    (await env.DB.prepare("SELECT word_count FROM book_metrics WHERE user_id=?").bind(user).first())
      .word_count,
    10000,
  );
  assert.equal(
    (
      await env.DB.prepare("SELECT COUNT(*) count FROM completion_events WHERE user_id=?")
        .bind(user)
        .first()
    ).count,
    1,
    "finished-book totals must be reconstructed from the imported library",
  );
  const idempotent = await request("/account/restore", "POST", {
    dryRun: false,
    confirm: true,
    backup,
  });
  assert.equal(idempotent.status, 200);
  assert.equal(
    (
      await env.DB.prepare("SELECT COUNT(*) count FROM annotations WHERE user_id=?")
        .bind(user)
        .first()
    ).count,
    1,
  );
  assert.equal(
    (
      await env.DB.prepare("SELECT COUNT(*) count FROM completion_events WHERE user_id=?")
        .bind(user)
        .first()
    ).count,
    1,
    "repeating restoration must not double-count finished books",
  );
  const exported = await request("/exports/reading-data/1342");
  assert.equal(exported.status, 200, JSON.stringify(exported));
  const compatible = await request("/account/restore", "POST", {
    dryRun: true,
    backup: exported.body,
  });
  assert.equal(compatible.status, 200, JSON.stringify(compatible));
  const presenceId1 = randomUUID();
  const presenceId2 = randomUUID();
  assert.equal(
    (
      await request("/notifications/reader-presence", "POST", {
        reading: true,
        clientId: presenceId1,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/notifications/reader-presence", "POST", {
        reading: true,
        clientId: presenceId2,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/notifications/reader-presence", "POST", {
        reading: false,
        clientId: presenceId1,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await env.DB.prepare("SELECT COUNT(*) count FROM reader_notification_silence WHERE user_id=?")
        .bind(user)
        .first()
    ).count,
    1,
  );
  const preferences = {
    email: true,
    inApp: true,
    webPush: false,
    mobilePush: false,
    topics: { social: false },
    quietHours: { enabled: true, start: "22:00", end: "07:00" },
    timezone: "America/New_York",
  };
  assert.equal((await request("/notifications/preferences", "POST", preferences)).status, 200);
  assert.equal(
    (
      await request("/notifications/preferences", "POST", {
        ...preferences,
        timezone: "Invalid/Timezone",
      })
    ).status,
    400,
  );
  assert.equal(
    notifications.isNotificationQuiet(
      preferences.quietHours,
      preferences.timezone,
      new Date("2026-11-01T04:30:00.000Z"),
    ),
    true,
  );
  assert.equal(
    notifications.isNotificationQuiet(
      preferences.quietHours,
      preferences.timezone,
      new Date("2026-11-01T17:30:00.000Z"),
    ),
    false,
  );
  const repeat = await request("/annotations", "POST", {
    clientId: randomUUID(),
    bookId: "1342",
    quote: "New offline note",
    cfi: "epubcfi(/6/2!)",
  });
  assert.equal(repeat.status, 201, JSON.stringify(repeat));
  const duplicate = await request("/annotations", "POST", {
    clientId: repeat.body.id,
    bookId: "1342",
    quote: "New offline note",
    cfi: "epubcfi(/6/2!)",
  });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate));
  // More than 100 notes must never silently disappear from a large library.
  const statements = [];
  for (let i = 0; i < 125; i++)
    statements.push(
      env.DB.prepare(
        "INSERT INTO annotations(id,user_id,book_id,book_title,author,quote,cfi,chapter,color,note,created_at,updated_at,version,progress) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        "pagination-note-" + i,
        user,
        "1342",
        "Pride and Prejudice",
        "Jane Austen",
        "Passage number " + i,
        "epubcfi(/6/" + (2 + i * 2) + "!)",
        "Chapter 1",
        "yellow",
        "",
        new Date(2026, 0, 1, 0, 0, i % 60).toISOString(),
        new Date(2026, 0, 1, 0, 0, i % 60).toISOString(),
        1,
        0.1,
      ),
    );
  await env.DB.batch(statements);
  const first = await request("/account/collection?kind=annotations&bookId=1342&limit=100");
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.body.items.length, 100);
  assert.equal(first.body.hasMore, true);
  const second = await request(
    "/account/collection?kind=annotations&bookId=1342&limit=100&offset=100",
  );
  assert.equal(second.status, 200, JSON.stringify(second));
  assert.equal(second.body.hasMore, false);
  assert.ok(second.body.items.length >= 25);
  const unique = new Set([...first.body.items, ...second.body.items].map((x) => x.id));
  assert.equal(unique.size, first.body.items.length + second.body.items.length);
  const initialAccount = await request("/account");
  assert.equal(initialAccount.status, 200);
  assert.ok(initialAccount.body.annotations.length <= 100, "initial account payload is bounded");
  console.log(
    "PASS: dry-run restoration, idempotent imports, reader silencing, DST, and paginated long-book annotations.",
  );
} finally {
  accountOwner?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
