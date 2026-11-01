import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-community-arena-"));
try {
  fs.cpSync("drizzle", path.join(scratch, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "src/features/fore/social.server.ts",
      "src/features/fore/community.server.ts",
      "src/features/fore/review-tags.ts",
      "src/features/fore/community-arena.ts",
    ],
    bundle: true, platform: "node", format: "esm", outdir: scratch,
    outExtension: { ".js": ".mjs" }, logLevel: "silent",
  });
  const social = await import(path.join(scratch, "social.server.mjs"));
  const community = await import(path.join(scratch, "community.server.mjs"));
  const tags = await import(path.join(scratch, "review-tags.mjs"));
  const arena = await import(path.join(scratch, "community-arena.mjs"));
  const env = localBindings(scratch), db = env.DB, at = new Date().toISOString();
  const req = (route, body) => new Request(`https://fore.test/api/fore${route}`, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const get = async (route, user) => {
    const response = await social.handleSocial(req(route), env, route.split("?")[0], user);
    assert.equal(response.status, 200, `GET ${route}`);
    return response.json();
  };
  const expected = "#Reread #DeepDive\n\nThe ending was worth a second reading.";
  assert.equal(tags.serializeTaggedReview("The ending was worth a second reading.", ["Reread", "DeepDive"]), expected);
  assert.deepEqual(tags.parseTaggedReview(expected), {
    body: "The ending was worth a second reading.", tags: ["Reread", "DeepDive"],
  });
  assert.deepEqual(tags.parseTaggedReview("An untagged review"), { body: "An untagged review", tags: [] });
  assert.equal(arena.readArenaPost(arena.makeArenaPost("take", "A controversial but thoughtful take.", "1342")).bookId, "1342");
  assert.equal(arena.readArenaPost("Unmarked content"), null);

  for (const user of ["alice", "bob"]) {
    await db.prepare(
      "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
    ).bind(user, user, `${user}@example.test`, user, at).run();
    await get("/social/me", user);
  }
  await db.prepare("UPDATE social_profiles SET profile_visibility='public',activity_visibility='public'").run();

  const payload = {
    contextType: "profile", contextId: "alice", postType: "prompt",
    visibility: "public", spoiler: false,
    body: arena.makeArenaPost("take", "The ending matters more than the beginning.", "1342"),
  };
  const createdResponse = await social.handleSocial(req("/social/posts", payload), env, "/social/posts", "alice");
  assert.equal(createdResponse.status, 201, "profile owner can post even when replies are restricted");
  const created = await createdResponse.json();
  const first = await get("/social/arena", "bob");
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].id, created.id);
  assert.equal(first.items[0].kind, "take");
  assert.equal(first.items[0].bookId, "1342");
  assert.equal(first.items[0].body, "The ending matters more than the beginning.");

  const voted = await social.handleSocial(req(`/social/posts/${created.id}/reaction`, {
    reaction: "agree", active: true,
  }), env, `/social/posts/${created.id}/reaction`, "bob");
  assert.equal(voted.status, 200);
  const tally = await get("/social/arena?sort=trending", "bob");
  assert.equal(tally.items[0].fire, 1);
  assert.equal(tally.items[0].clown, 0);
  await assert.rejects(
    () => social.handleSocial(req(`/social/posts/${created.id}/reaction`, {
      reaction: "funny", active: true,
    }), env, `/social/posts/${created.id}/reaction`, "bob"),
    /Remove your previous vote/,
    "A reader cannot vote Fire and Clown simultaneously",
  );
  await social.handleSocial(req(`/social/posts/${created.id}/reaction`, {
    reaction: "agree", active: false,
  }), env, `/social/posts/${created.id}/reaction`, "bob");
  await social.handleSocial(req(`/social/posts/${created.id}/reaction`, {
    reaction: "funny", active: true,
  }), env, `/social/posts/${created.id}/reaction`, "bob");
  const swapped = await get("/social/arena", "bob");
  assert.equal(swapped.items[0].fire, 0);
  assert.equal(swapped.items[0].clown, 1);

  await db.prepare(
    "INSERT INTO reviews(id,user_id,book_id,rating_steps,body,visibility,spoiler,word_count,created_at,updated_at) VALUES(?,?,?,?,?,'public',0,?,?,?)",
  ).bind("review_arena_1", "alice", "1342", 8, expected, 8, at, at).run();
  const mockGetBook = async (_env, id) => ({ id, sourceExternalId: id });
  const filtered = await community.handleCommunity(
    req("/books/1342/reviews?tag=Reread&q=ending"), env, "/books/1342/reviews", "bob", mockGetBook,
  );
  assert.equal(filtered.status, 200);
  const result = await filtered.json();
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].body, "The ending was worth a second reading.");
  assert.deepEqual(result.reviews[0].tags, ["Reread", "DeepDive"]);
  const noMatches = await community.handleCommunity(
    req("/books/1342/reviews?tag=Audiobook"), env, "/books/1342/reviews", "bob", mockGetBook,
  );
  assert.equal((await noMatches.json()).reviews.length, 0);

  const owner = await social.handleSocial(req("/social/block", {
    userId: "bob", blocked: true,
  }), env, "/social/block", "alice");
  assert.equal(owner.status, 200);
  assert.equal((await get("/social/arena", "bob")).items.length, 0, "blocking hides Arena posts");

  const source = fs.readFileSync("src/features/fore/social.server.ts", "utf8");
  const arenaRead = source.split('if (method === "GET" && path === "/social/arena")')[1]
    .split('if (method === "GET" && path === "/social/posts")')[0];
  assert.doesNotMatch(arenaRead, /\\b(?:INSERT|UPDATE|DELETE|REPLACE)\\s+(?:INTO|FROM|\\w)/i,
    "Arena GET must not add canonical writers");
  assert.match(source, /LIMIT 80/, "Arena feed must be bounded");
  assert.match(fs.readFileSync("src/features/fore/Community.tsx", "utf8"), /lazy\(\(\) => import\("\.\/CommunityArena"\)/);
  console.log("PASS: review labels/search, Arena publishing/reactions/privacy, and bounded read-only feed");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
