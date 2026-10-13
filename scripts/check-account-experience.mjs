import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

// Local-only harness simulates a trusted, already-authenticated platform user.
// The production Cloudflare gateway strips any such client-supplied headers.
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cove-private-account-"));
try {
  fs.cpSync("drizzle", path.join(folder, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(folder, "api.mjs"),
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(folder, "api.mjs"));
  const env = localBindings(folder);
  async function request(userId, resource, method = "GET", data) {
    const response = await handleCoveApi(
      new Request("https://fore.test/api/fore" + resource, {
        method,
        headers: {
          origin: "https://fore.test",
          "oai-authenticated-user-id": userId,
          "oai-authenticated-user-email": userId + "@example.com",
          ...(data ? { "content-type": "application/json" } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      }),
      env,
    );
    return { status: response.status, data: await response.json() };
  }
  const alice = "account-test-alice",
    bob = "account-test-bob";
  assert.equal((await request(alice, "/profile", "POST", { name: "Alice Reader" })).status, 200);
  let mine = await request(alice, "/account");
  assert.equal(mine.status, 200);
  assert.equal(mine.data.user.name, "Alice Reader");
  assert.equal(mine.data.user.registered, true);
  const word = await request(alice, "/definitions", "POST", {
    word: "serendipity",
    meaning: "a happy unexpected discovery",
    bookId: "",
    source: "test",
  });
  assert.equal(word.status, 201, JSON.stringify(word));
  mine = await request(alice, "/account");
  assert.equal(mine.data.definitions.length, 1);
  assert.equal(mine.data.definitions[0].word, "serendipity");
  assert.equal((await request(bob, "/account")).data.definitions.length, 0);
  const ended = new Date(),
    started = new Date(ended.getTime() - 121000);
  const session = {
    id: randomUUID(),
    bookId: "1342",
    mode: "read",
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    activeSeconds: 60,
    wordsRead: 120,
  };
  assert.equal((await request(alice, "/sessions", "PUT", session)).status, 200);
  assert.equal((await request(alice, "/sessions", "PUT", session)).status, 200);
  assert.equal(
    (
      await request(alice, "/metrics", "PUT", {
        bookId: "1342",
        wordCount: 120000,
        readingLevel: 7.4,
        language: "en",
      })
    ).status,
    200,
  );
  const year = new Date().getUTCFullYear();
  assert.equal((await request(alice, "/goals", "PUT", { year, books: 15 })).status, 200);
  const stats = await request(alice, "/stats?days=30");
  assert.equal(stats.status, 200, JSON.stringify(stats));
  assert.equal(stats.data.totals.readSeconds, 60);
  assert.equal(stats.data.totals.sessions, 1, "Duplicate client saves must not double count");
  assert.equal(stats.data.totals.wpm, 120);
  assert.equal(stats.data.goal.target, 15);
  assert.equal(stats.data.daily.length, 1);
  assert.equal(stats.data.vocabulary[0].word, "serendipity");
  const other = await request(bob, "/stats?days=30");
  assert.equal(other.status, 200);
  assert.equal(other.data.totals.readSeconds, 0);
  assert.equal(other.data.vocabulary.length, 0);
  const invalid = await request(alice, "/sessions", "PUT", {
    ...session,
    id: randomUUID(),
    activeSeconds: 50000,
  });
  assert.equal(invalid.status, 400);
  const exportData = await request(alice, "/export");
  assert.equal(exportData.status, 200);
  assert.equal(exportData.data.version, 4);
  assert.ok(Array.isArray(exportData.data.support.tickets));
  assert.equal(exportData.data.reading.goals[0].books, 15);
  assert.equal(exportData.data.reading.bookMetrics[0].word_count, 120000);
  assert.equal(exportData.data.reading.sessions.length, 1);
  assert.deepEqual(exportData.data.reading.bookmarks, []);

  assert.equal((await request(alice, "/definitions/" + word.data.id, "DELETE")).status, 200);
  assert.equal((await request(alice, "/account")).data.definitions.length, 0);
  console.log(
    "PASS: account profiles, private saved definitions, idempotent sessions, reading stats, goals, measurements, exports and user isolation",
  );
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
