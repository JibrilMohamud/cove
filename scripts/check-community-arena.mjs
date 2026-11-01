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
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: scratch,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const social = await import(path.join(scratch, "social.server.mjs"));
  const community = await import(path.join(scratch, "community.server.mjs"));
  const tags = await import(path.join(scratch, "review-tags.mjs"));
  const arena = await import(path.join(scratch, "community-arena.mjs"));
  const env = localBindings(scratch),
    db = env.DB,
    at = new Date().toISOString();
  const req = (route, body) =>
    new Request(
      `https://fore.test/api/fore${route}`,
      body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
  const get = async (route, user) => {
    const response = await social.handleSocial(req(route), env, route.split("?")[0], user);
    assert.equal(response.status, 200, `GET ${route}`);
    return response.json();
  };
  const expected = "#Reread #DeepDive\n\nThe ending was worth a second reading.";
  assert.equal(
    tags.serializeTaggedReview("The ending was worth a second reading.", ["Reread", "DeepDive"]),
    expected,
  );
  assert.deepEqual(tags.parseTaggedReview(expected), {
    body: "The ending was worth a second reading.",
    tags: ["Reread", "DeepDive"],
  });
  assert.deepEqual(tags.parseTaggedReview("An untagged review"), {
    body: "An untagged review",
    tags: [],
  });
  assert.equal(
    arena.readArenaPost(arena.makeArenaPost("take", "A controversial but thoughtful take.", "1342"))
      .bookId,
    "1342",
  );
  assert.equal(arena.readArenaPost("Unmarked content"), null);

  for (const user of ["alice", "bob"]) {
    await db
      .prepare(
        "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(user, user, `${user}@example.test`, user, at)
      .run();
    await get("/social/me", user);
  }
  await db
    .prepare("UPDATE social_profiles SET profile_visibility='public',activity_visibility='public'")
    .run();

  const payload = {
    contextType: "profile",
    contextId: "alice",
    postType: "prompt",
    visibility: "public",
    spoiler: false,
    body: arena.makeArenaPost("take", "The ending matters more than the beginning.", "1342"),
  };
  const createdResponse = await social.handleSocial(
    req("/social/posts", payload),
    env,
    "/social/posts",
    "alice",
  );
  assert.equal(
    createdResponse.status,
    201,
    "profile owner can post even when replies are restricted",
  );
  const created = await createdResponse.json();
  const first = await get("/social/arena", "bob");
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].id, created.id);
  assert.equal(first.items[0].kind, "take");
  assert.equal(first.items[0].bookId, "1342");
  assert.equal(first.items[0].body, "The ending matters more than the beginning.");
  const guestFeed = await get("/social/arena", null);
  assert.equal(guestFeed.items.length, 1, "signed-out readers can browse Community posts");
  assert.equal(guestFeed.items[0].id, created.id);
  const publicDiscovery = await get("/social/discover", null);
  assert.ok(publicDiscovery.people.some((person) => person.user_id === "alice"));
  const followResponse = await social.handleSocial(
    req("/social/follow", { userId: "alice", following: true }),
    env,
    "/social/follow",
    "bob",
  );
  assert.equal(followResponse.status, 200);
  const network = await get("/social/network", "bob");
  assert.equal(network.people.length, 1, "Settings Network must show actual followed readers");
  assert.equal(network.people[0].user_id, "alice");
  assert.deepEqual(network.blocked, []);
  assert.equal(network.nextCursor, null);
  assert.equal((await get("/social/arena?kind=matchup", "bob")).items.length, 0);
  assert.equal((await get("/social/arena?kind=take", "bob")).items.length, 1);

  const voted = await social.handleSocial(
    req(`/social/posts/${created.id}/reaction`, {
      reaction: "agree",
      active: true,
    }),
    env,
    `/social/posts/${created.id}/reaction`,
    "bob",
  );
  assert.equal(voted.status, 200);
  const tally = await get("/social/arena?sort=trending", "bob");
  assert.equal(tally.items[0].fire, 1);
  assert.equal(tally.items[0].clown, 0);
  await assert.rejects(
    () =>
      social.handleSocial(
        req(`/social/posts/${created.id}/reaction`, {
          reaction: "funny",
          active: true,
        }),
        env,
        `/social/posts/${created.id}/reaction`,
        "bob",
      ),
    /Remove your previous vote/,
    "A reader cannot vote Fire and Clown simultaneously",
  );
  await social.handleSocial(
    req(`/social/posts/${created.id}/reaction`, {
      reaction: "agree",
      active: false,
    }),
    env,
    `/social/posts/${created.id}/reaction`,
    "bob",
  );
  await social.handleSocial(
    req(`/social/posts/${created.id}/reaction`, {
      reaction: "funny",
      active: true,
    }),
    env,
    `/social/posts/${created.id}/reaction`,
    "bob",
  );
  const swapped = await get("/social/arena", "bob");
  assert.equal(swapped.items[0].fire, 0);
  assert.equal(swapped.items[0].clown, 1);

  await db
    .prepare(
      "INSERT INTO reviews(id,user_id,book_id,rating_steps,body,visibility,spoiler,word_count,created_at,updated_at) VALUES(?,?,?,?,?,'public',0,?,?,?)",
    )
    .bind("review_arena_1", "alice", "1342", 8, expected, 8, at, at)
    .run();
  const mockGetBook = async (_env, id) => ({ id, sourceExternalId: id });
  const filtered = await community.handleCommunity(
    req("/books/1342/reviews?tag=Reread&q=ending"),
    env,
    "/books/1342/reviews",
    "bob",
    mockGetBook,
  );
  assert.equal(filtered.status, 200);
  const result = await filtered.json();
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].body, "The ending was worth a second reading.");
  assert.deepEqual(result.reviews[0].tags, ["Reread", "DeepDive"]);
  const noMatches = await community.handleCommunity(
    req("/books/1342/reviews?tag=Audiobook"),
    env,
    "/books/1342/reviews",
    "bob",
    mockGetBook,
  );
  assert.equal((await noMatches.json()).reviews.length, 0);

  const owner = await social.handleSocial(
    req("/social/block", {
      userId: "bob",
      blocked: true,
    }),
    env,
    "/social/block",
    "alice",
  );
  assert.equal(owner.status, 200);
  assert.equal((await get("/social/arena", "bob")).items.length, 0, "blocking hides Arena posts");
  const blockedNetwork = await get("/social/network", "alice");
  assert.equal(blockedNetwork.blocked[0]?.user_id, "bob");

  // Staging/demo authors use the normal authenticated social API, not a
  // direct social_posts INSERT or a privileged production seeding backdoor.
  const fixture = JSON.parse(
    fs.readFileSync("scripts/fixtures/community-arena-starter-posts.json", "utf8"),
  );
  assert.equal(fixture.identity.id, "cove_arena_demo");
  await db
    .prepare(
      "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(
      fixture.identity.id,
      fixture.identity.id,
      "cove-arena-demo@example.test",
      fixture.identity.username,
      at,
    )
    .run();
  await get("/social/me", fixture.identity.id);
  await db
    .prepare(
      "UPDATE social_profiles SET profile_visibility='public',activity_visibility='public' WHERE user_id=?",
    )
    .bind(fixture.identity.id)
    .run();
  const publishedIds = [];
  for (const seed of fixture.posts) {
    assert.ok(["take", "debate", "matchup"].includes(seed.kind));
    if (seed.kind === "matchup") {
      assert.match(seed.text, /^A: Jane Eyre/);
      assert.match(seed.text, /B: Pride and Prejudice/);
    }
    const response = await social.handleSocial(
      req("/social/posts", {
        contextType: "profile",
        contextId: fixture.identity.id,
        postType: "prompt",
        body: arena.makeArenaPost(seed.kind, seed.text, seed.bookId),
        visibility: "public",
        spoiler: false,
      }),
      env,
      "/social/posts",
      fixture.identity.id,
    );
    assert.equal(response.status, 201, "demo post must pass the existing social API");
    publishedIds.push((await response.json()).id);
  }
  assert.equal(new Set(publishedIds).size, fixture.posts.length);
  const demoPublic = await get("/social/arena", null);
  const demoEntries = demoPublic.items.filter((post) => publishedIds.includes(post.id));
  assert.equal(demoEntries.length, fixture.posts.length, "all demo posts are publicly visible");
  for (const [kind, expectedCount] of [
    ["take", 3],
    ["debate", 2],
    ["matchup", 1],
  ]) {
    const category = await get(`/social/arena?kind=${kind}`, null);
    const count = category.items.filter((post) => publishedIds.includes(post.id)).length;
    assert.equal(count, expectedCount, `demo ${kind} count`);
  }
  assert.ok(
    demoEntries.some(
      (entry) =>
        entry.kind === "matchup" &&
        entry.body.includes("Jane Eyre") &&
        entry.body.includes("Pride and Prejudice"),
    ),
  );

  const source = fs.readFileSync("src/features/fore/social.server.ts", "utf8");
  const arenaRead = source
    .split('if (method === "GET" && path === "/social/arena")')[1]
    .split('if (method === "GET" && path === "/social/posts")')[0];
  assert.doesNotMatch(
    arenaRead,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|\w)/i,
    "Arena GET must not add canonical writers",
  );
  assert.match(source, /LIMIT 80/, "Arena feed must be bounded");
  const networkSource = source
    .split('if (method === "GET" && path === "/social/network")')[1]
    .split('if (method === "GET" && path === "/social/discover")')[0];
  assert.ok(networkSource, "Network GET endpoint must exist");
  assert.match(networkSource, /LIMIT 31/, "Following must be keyset-bounded");
  assert.match(networkSource, /LIMIT 100/, "Blocked list must be bounded");
  assert.doesNotMatch(
    networkSource,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+/i,
    "Settings Network GET cannot introduce a new canonical D1 writer",
  );
  const communityPage = fs.readFileSync("src/features/fore/Community.tsx", "utf8");
  assert.match(
    communityPage,
    /params\.get\("tab"\) \|\| "arena"/,
    "Public Arena must be the Community default",
  );
  const communityNavigation = communityPage
    .split('<nav className="community-tabs"')[1]
    .split("].map(")[0];
  assert.doesNotMatch(
    communityNavigation,
    /"received"|"sharing"|"me"/,
    "private tools must not appear in Community navigation",
  );
  const accountRoute = fs.readFileSync("src/routes/profile.tsx", "utf8");
  for (const section of ["me", "sharing", "received"])
    assert.match(
      accountRoute,
      new RegExp('"' + section + '"'),
      "Private tools should be accessible from My Account",
    );
  assert.match(
    fs.readFileSync("src/features/fore/Community.tsx", "utf8"),
    /import\("\.\/CommunityArena"\)/,
  );
  const arenaUi = fs.readFileSync("src/features/fore/CommunityArena.tsx", "utf8");
  const arenaStyle = fs.readFileSync("src/features/fore/community-arena-experience.css", "utf8");
  assert.match(arenaUi, /import ".\/community-arena-experience\.css"/);
  assert.match(arenaUi, /CONTROVERSY PROMPTS/, "visible prompts strip");
  assert.match(arenaUi, /setPromptOffset/, "shuffle prompts must be interactive");
  assert.match(
    arenaUi,
    /openComposer\(prompt\.kind, prompt\.question\)/,
    "prompts must prefill the real composer",
  );
  assert.match(arenaUi, /"trending"\);/, "the default sort must be Trending");
  assert.match(arenaUi, /Trending · Most divisive/);
  assert.match(arenaUi, /"community-bracket"/, "bracket needs its own query");
  assert.match(arenaUi, /kind=matchup/, "only published matchups go in the bracket");
  assert.match(arenaUi, /refetchInterval: 30_000/, "activity must refresh from real data");
  assert.match(arenaUi, /<Dialog open=\{bracketOpen\}/, "View Bracket must open a real panel");
  assert.match(arenaUi, /<ReaderCover title=\{name\}/, "matchups have book-cover support");
  assert.match(arenaUi, /!publicProfile/, "posting still requires public profile and activity");
  assert.match(arenaUi, /post\.spoiler/, "spoilers must still be protected");
  assert.match(arenaUi, /setReporting/, "existing post reporting must remain");
  assert.doesNotMatch(
    arenaUi,
    /1,245|37 more actions|time left|ROUND OF 16/,
    "no made-up live metrics",
  );
  assert.match(arenaStyle, /@media \(max-width: 570px\)/, "small-screen responsive rules");
  assert.match(arenaStyle, /prefers-reduced-motion/, "respect reduced motion");
  assert.match(
    arenaRead,
    /balance \* confidence \* 6/,
    "Trending must prioritize evidenced divisiveness",
  );
  for (const id of ["1260", "1342"]) {
    assert.ok(fs.existsSync("public/covers/" + id + ".jpg"), "bracket cover must exist: " + id);
  }

  console.log(
    "PASS: review filters, demo test-account seed of six literary posts, public Arena, voting, privacy, bounded feed",
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
