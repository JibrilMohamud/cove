import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-social-pages-"));
try {
  fs.cpSync("drizzle", path.join(scratch, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/api.server.ts", "src/features/fore/social.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: scratch,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const api = await import(path.join(scratch, "api.server.mjs")),
    social = await import(path.join(scratch, "social.server.mjs"));
  const env = localBindings(scratch),
    db = env.DB,
    at = "2026-10-13T00:00:00.000Z";
  const req = (route) =>
    new Request(`https://fore.test/api/fore${route}`, {
      headers: {
        "oai-authenticated-user-id": "bob",
        "oai-authenticated-user-email": "bob@example.test",
      },
    });
  const call = async (route) =>
    (await social.handleSocial(req(route), env, route.split("?")[0], "bob")).json();
  await api.handleCoveApi(req("/catalog?q=pride"), env);
  for (const user of ["alice", "bob"]) {
    await db
      .prepare(
        "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(user, user, `${user}@example.test`, user, at)
      .run();
    await social.handleSocial(req("/social/me"), env, "/social/me", user);
  }
  await db
    .prepare("UPDATE social_profiles SET profile_visibility='public',activity_visibility='public'")
    .run();
  await db
    .prepare(
      "INSERT INTO social_follows(follower_user_id,followed_user_id,created_at) VALUES('bob','alice',?)",
    )
    .bind(at)
    .run();
  const product = await db
    .prepare("SELECT id FROM products WHERE id='1342' OR source_external_id='1342' LIMIT 1")
    .first();
  // More than one scan batch of inaccessible entries, followed by accessible events
  // with precisely the same timestamp. Both conditions previously lost history.
  for (let i = 0; i < 160; i++)
    await db
      .prepare(
        "INSERT INTO social_events(id,user_id,event_type,entity_type,entity_id,visibility,created_at) VALUES(?,'alice','top_books_changed','profile','alice',?,?)",
      )
      .bind(`event_${String(i).padStart(4, "0")}`, i >= 15 ? "private" : "public", at)
      .run();
  let cursor = "",
    events = [],
    emptyPages = 0;
  do {
    const page = await call(
      `/social/feed?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    events.push(...page.items);
    if (!page.items.length && page.nextCursor) emptyPages++;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(events.length, 15);
  assert.equal(new Set(events.map((e) => e.id)).size, 15);
  assert.ok(emptyPages > 0, "filtered pages must retain continuation");
  for (let i = 0; i < 125; i++)
    await db
      .prepare(
        "INSERT INTO social_posts(id,user_id,context_type,context_id,product_id,body,visibility,progress,cfi,passage_text,created_at,updated_at) VALUES(?,'alice','margin',?,?,?,'public',0,?,?,?,?)",
      )
      .bind(
        `post_${String(i).padStart(4, "0")}`,
        product.id,
        product.id,
        `body ${i}`,
        `epubcfi(/6/2!/4/2:${i})`,
        `passage ${i}`,
        at,
        at,
      )
      .run();
  cursor = "";
  let posts = [];
  do {
    const page = await call(
      `/social/posts?contextType=margin&contextId=1342&progress=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    posts.push(...page.posts);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(posts.length, 125);
  assert.equal(new Set(posts.map((p) => p.id)).size, 125);
  cursor = "";
  let clusters = [];
  do {
    const page = await call(
      `/social/reader/1342?mode=public&progress=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    clusters.push(...page.indicators);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(clusters.length, 125, "density cannot discard older clusters");
  for (let i = 0; i < 72; i++) {
    const id = `member_${String(i).padStart(3, "0")}`;
    await db
      .prepare(
        "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(id, id, `${id}@example.test`, id, at)
      .run();
    await social.handleSocial(req("/social/me"), env, "/social/me", id);
  }
  await db.prepare("UPDATE social_profiles SET profile_visibility='public'").run();
  await db
    .prepare(
      "INSERT INTO social_blocks(blocker_user_id,blocked_user_id,created_at) VALUES('bob','member_005',?)",
    )
    .bind(at)
    .run();
  cursor = "";
  let members = [];
  do {
    const page = await call(`/social/discover?q=member&after=${encodeURIComponent(cursor)}`);
    members.push(...page.people);
    cursor = page.nextPeopleCursor;
  } while (cursor);
  assert.equal(members.length, 71);
  assert.ok(!members.some((p) => p.user_id === "member_005"));
  assert.equal((await call("/social/discover?q=member_071")).people[0].user_id, "member_071");
  await assert.rejects(call("/social/feed?cursor=broken"), /Invalid activity cursor/);
  await db
    .prepare(
      "INSERT INTO social_posts(id,user_id,context_type,context_id,product_id,body,visibility,progress,created_at,updated_at) VALUES('future_post','alice','margin',?,?,'Future spoiler','public',0.5,?,?)",
    )
    .bind(product.id, product.id, at, at)
    .run();
  const future = await call(
    "/social/posts?contextType=margin&contextId=1342&progress=1&postId=future_post",
  );
  assert.equal(future.posts[0].locked, true, "client progress cannot unlock an unreached passage");
  assert.equal(future.posts[0].body, undefined);
  const reactionRequest = new Request(
    "https://fore.test/api/fore/social/posts/future_post/reaction",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reaction: "heart", active: true }),
    },
  );
  await assert.rejects(
    social.handleSocial(reactionRequest, env, "/social/posts/future_post/reaction", "bob"),
    /Reach this passage/,
  );
  console.log(
    "PASS: filtered feed continuation, tied timestamps, all older discussions and passage clusters, member search pagination, and block privacy.",
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
