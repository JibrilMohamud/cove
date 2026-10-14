import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-journey-access-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "src/features/fore/api.server.ts",
      "src/features/fore/social.server.ts",
      "src/features/fore/spoiler-progress.server.ts",
      "src/features/fore/account-management.server.ts",
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const api = await import(path.join(root, "api.server.mjs")),
    social = await import(path.join(root, "social.server.mjs")),
    spoilerProgress = await import(path.join(root, "spoiler-progress.server.mjs"));
  const env = localBindings(root),
    db = env.DB,
    at = new Date().toISOString();
  const request = (route, method = "GET", body, user = "alice") =>
    new Request(`https://fore.test/api/fore${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(user
          ? {
              "oai-authenticated-user-id": user,
              "oai-authenticated-user-email": `${user}@example.test`,
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (route, method = "GET", body, user = "alice") => {
    const r = await social.handleSocial(
      request(route, method, body, user),
      env,
      route.split("?")[0],
      user,
    );
    return r.json();
  };
  const testCues = [{ trackId: "track", start: 0, end: 10, progress: 0.2, endProgress: 0.8 }];
  for (const seconds of [NaN, Infinity, -1])
    assert.equal(spoilerProgress.progressAtVerifiedCues(testCues, "track", seconds), 0);
  assert.equal(spoilerProgress.progressAtVerifiedCues(testCues, "track", 9.9), 0.2);
  assert.equal(spoilerProgress.progressAtVerifiedCues(testCues, "track", 10), 0.8);
  await api.handleCoveApi(request("/catalog?q=pride"), env);
  for (const user of ["alice", "bob", "charlie"]) {
    await db
      .prepare(
        "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(user, user, `${user}@example.test`, user, at)
      .run();
    await call("/social/me", "GET", undefined, user);
  }
  const product = (
    await db.prepare("SELECT id FROM products WHERE source_external_id='1342'").first()
  ).id;
  await db
    .prepare(
      "INSERT INTO completion_events(id,user_id,product_id,external_book_id,finished_at) VALUES('completion','alice',?,'1342',?)",
    )
    .bind(product, at)
    .run();
  const journey = await social.ensureReadingJourney(db, "alice", "completion");
  assert.equal(journey.visibility, "followers");
  assert.equal(journey.share_token, null, "completion cannot silently enable a bearer URL");
  await call(`/social/journeys/${journey.id}`, "PATCH", {
    visibility: "private",
    expectedVersion: 1,
  });
  const route = `/social/journeys/${journey.id}/recipients`;
  await assert.rejects(
    call(route, "POST", { recipientUserId: "bob", expectedVersion: 0, audienceConfirmed: false }),
    /Confirm/,
  );
  const grant = await call(route, "POST", {
    recipientUserId: "bob",
    expectedVersion: 0,
    audienceConfirmed: true,
  });
  assert.equal(
    (await call(`/social/journeys/${grant.shareToken}`, "GET", undefined, "bob")).id,
    journey.id,
  );
  const accountModule = await import(path.join(root, "account-management.server.mjs"));
  const ownerExport = await accountModule.accountDataExport(db, "alice");
  const memberExport = await accountModule.accountDataExport(db, "bob");
  const outsiderExport = await accountModule.accountDataExport(db, "charlie");
  assert.equal(ownerExport.community.social.journeyRecipients.length, 1);
  assert.equal(memberExport.community.social.journeyRecipients.length, 1);
  assert.equal(outsiderExport.community.social.journeyRecipients.length, 0);
  assert.equal(memberExport.community.social.journeyRecipients[0].share_token, undefined);

  assert.equal(
    (await call(`/social/journeys/${journey.id}`, "GET", undefined, "bob")).id,
    journey.id,
  );
  for (const user of [null, "charlie"]) {
    await assert.rejects(
      call(`/social/journeys/${grant.shareToken}`, "GET", undefined, user),
      /not found/,
    );
    await assert.rejects(
      call(`/social/journeys/${grant.shareToken}/card.svg`, "GET", undefined, user),
      /not found/,
    );
  }
  await assert.rejects(
    call(route, "POST", { recipientUserId: "bob", expectedVersion: 0, audienceConfirmed: true }),
    /changed/,
  );
  await call(route, "DELETE", { recipientUserId: "bob", expectedVersion: grant.version });
  await assert.rejects(
    call(`/social/journeys/${grant.shareToken}`, "GET", undefined, "bob"),
    /not found/,
  );
  await assert.rejects(
    call(`/social/journeys/${journey.id}`, "GET", undefined, "bob"),
    /not found/,
  );
  const tokenRoute = `/social/journeys/${journey.id}/share-token`;
  await assert.rejects(
    call(tokenRoute, "POST", { action: "rotate", expectedVersion: 2 }),
    /Confirm/,
  );
  const bearer = await call(tokenRoute, "POST", {
    action: "rotate",
    expectedVersion: 2,
    audienceConfirmed: true,
  });
  assert.equal(
    (await call(`/social/journeys/${bearer.shareToken}`, "GET", undefined, null)).id,
    journey.id,
  );
  await call(tokenRoute, "POST", { action: "revoke", expectedVersion: 3 });
  await assert.rejects(
    call(`/social/journeys/${bearer.shareToken}`, "GET", undefined, null),
    /not found/,
  );
  const prefs = (await call("/social/reader/1342?progress=1")).preferences;
  await call("/social/reader/preferences", "POST", { ...prefs, enabled: true, density: 0 });
  assert.equal((await call("/social/reader/1342")).preferences.density, 0);
  assert.equal((await call("/social/reader/1342?density=0")).preferences.density, 0);
  // A journey's elapsed listening fraction alone cannot unlock a text passage.
  await social.recordReadingProgress(db, "bob", product, { source: "audiobook", progress: 1 });
  await db
    .prepare(
      "INSERT INTO social_posts(id,user_id,context_type,context_id,product_id,body,visibility,progress,created_at,updated_at) VALUES('spoiler','alice','margin',?,?,'Secret passage','public',0.3,?,?)",
    )
    .bind(product, product, at, at)
    .run();
  assert.equal(
    (await call("/social/reader/1342?mode=public&progress=1", "GET", undefined, "bob")).indicators
      .length,
    0,
  );
  await assert.rejects(
    call("/social/posts?contextType=margin&contextId=1342&progress=NaN", "GET", undefined, "bob"),
    /nan|number/i,
  );
  await db
    .prepare(
      "INSERT INTO social_follows(follower_user_id,followed_user_id,created_at) VALUES('bob','alice',?)",
    )
    .bind(at)
    .run();
  await db
    .prepare(
      "INSERT INTO social_events(id,user_id,event_type,entity_type,entity_id,product_id,visibility,payload_json,created_at) VALUES('spoiler_feed','alice','discussion_started','post','spoiler',?,'public',?,?)",
    )
    .bind(product, JSON.stringify({ body: "Secret passage" }), at)
    .run();
  const hiddenFeed = (await call("/social/feed", "GET", undefined, "bob")).items.find(
    (e) => e.id === "spoiler_feed",
  );
  assert.equal(hiddenFeed.payload.locked, true);
  assert.equal(hiddenFeed.payload.body, undefined);
  assert.ok(!hiddenFeed.payload_json.includes("Secret passage"));
  const sha = "a".repeat(64);
  await db
    .prepare(
      "UPDATE asset_versions SET sha256=? WHERE id IN (SELECT da.current_version_id FROM digital_assets da JOIN products p ON p.edition_id=da.edition_id WHERE p.id=? AND da.kind='epub')",
    )
    .bind(sha, product)
    .run();
  await db
    .prepare(
      "INSERT INTO audio_editions(id,gutenberg_id,book_id,title,authors_json,language,narration,source_url,rights,tracks_json,alignment_json,epub_sha256,updated_at) VALUES('audio','1342','1342','Test audio','[]','en','human','https://example.test/1342','Public domain in the USA.',?,?,?,?)",
    )
    .bind(
      JSON.stringify([{ id: "track", duration: 1000, sha256: "c".repeat(64) }]),
      JSON.stringify({
        version: 1,
        verified: true,
        cues: [{ trackId: "track", start: 0, end: 1000, progress: 0.4, endProgress: 0.9 }],
      }),
      sha,
      at,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO playback(user_id,edition_id,track_id,seconds,speed,version,updated_at) VALUES('bob','audio','track',500,1,1,?)",
    )
    .bind(at)
    .run();
  const reached = await call("/social/reader/1342?mode=public&progress=0", "GET", undefined, "bob");
  assert.equal(reached.progress, 0.4);
  const reachedPosts = await call(
    "/social/posts?contextType=margin&contextId=1342&progress=0",
    "GET",
    undefined,
    "bob",
  );
  assert.ok(
    reachedPosts.posts.some((post) => post.body === "Secret passage"),
    "saved progress overrides caller under-reporting",
  );
  const report = await call(
    "/social/report",
    "POST",
    { subjectType: "social_post", subjectId: "spoiler", reason: "other" },
    "bob",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT subject_type FROM moderation_cases WHERE id=?")
        .bind(report.id)
        .first()
    ).subject_type,
    "user",
  );
  assert.equal(
    JSON.parse(
      (
        await db
          .prepare("SELECT evidence_json FROM moderation_case_reports WHERE case_id=?")
          .bind(report.id)
          .first()
      ).evidence_json,
    ).socialSubjectId,
    "spoiler",
  );
  await db
    .prepare(
      "INSERT INTO biosync_positions(user_id,book_id,edition_id,mode,cfi,track_id,seconds,epub_sha256,audio_sha256,version,updated_at) VALUES('charlie','1342','audio','audio','epubcfi(/6/2!)','track',1000,?, ?,1,?)",
    )
    .bind(sha, "c".repeat(64), at)
    .run();
  assert.equal(
    (await call("/social/reader/1342?mode=public", "GET", undefined, "charlie")).progress,
    0.9,
  );
  const inheritedReply = await call(
    "/social/posts",
    "POST",
    {
      contextType: "margin",
      contextId: "1342",
      parentId: "spoiler",
      postType: "reply",
      body: "A location-inheriting reply",
      visibility: "public",
    },
    "bob",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT progress FROM social_posts WHERE id=?")
        .bind(inheritedReply.id)
        .first()
    ).progress,
    0.3,
  );
  assert.equal(
    reached.indicators[0].posts[0].body,
    "Secret passage",
    "saved aligned audio is authoritative, not the caller progress",
  );
  const group = (await call("/social/groups", "POST", { name: "Audio club", visibility: "public" }))
    .id;
  await db
    .prepare(
      "INSERT INTO reading_group_members(group_id,user_id,role,status,joined_at,created_at,updated_at) VALUES(?,'bob','member','active',?,?,?)",
    )
    .bind(group, at, at, at)
    .run();
  await db
    .prepare(
      "INSERT INTO reading_group_books(id,group_id,product_id,work_id,title_snapshot,status,position,created_at,updated_at) VALUES('group_book',?,?,NULL,'Test book','current',0,?,?)",
    )
    .bind(group, product, at, at)
    .run();
  const post = await call(
    "/social/posts",
    "POST",
    {
      contextType: "group",
      contextId: group,
      body: "Audio discussion",
      visibility: "group",
      progress: 1,
    },
    "bob",
  );
  assert.equal(
    (await db.prepare("SELECT progress FROM social_posts WHERE id=?").bind(post.id).first())
      .progress,
    0.4,
  );
  assert.equal(
    (await call(`/social/groups/${group}`, "GET", undefined, "bob")).progress[0].viewerProgress,
    0.4,
  );
  await db
    .prepare(
      "INSERT INTO reading_group_members(group_id,user_id,role,status,joined_at,created_at,updated_at) VALUES(?,'charlie','member','active',?,?,?)",
    )
    .bind(group, at, at, at)
    .run();
  const groupState = await call(`/social/groups/${group}`, "GET", undefined, "bob");
  assert.deepEqual(
    Object.fromEntries(groupState.progress[0].buckets.map((b) => [b.bucket, b.count])),
    { not_started: 1, middle: 1, late: 1 },
    "group totals include ordinary audio and BioSync text mapping",
  );
  for (let i = 0; i < 40; i++) {
    const userId = `batch_member_${i}`;
    await db
      .prepare(
        "INSERT INTO reading_group_members(group_id,user_id,role,status,joined_at,created_at,updated_at) VALUES(?,?,'member','active',?,?,?)",
      )
      .bind(group, userId, at, at, at)
      .run();
    await db
      .prepare(
        "INSERT INTO playback(user_id,edition_id,track_id,seconds,speed,version,updated_at) VALUES(?,'audio','track',500,1,1,?)",
      )
      .bind(userId, at)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO reading_group_members(group_id,user_id,role,status,joined_at,created_at,updated_at) VALUES(?,'former_member','member','removed',?,?,?)",
    )
    .bind(group, at, at, at)
    .run();
  await db
    .prepare(
      "INSERT INTO playback(user_id,edition_id,track_id,seconds,speed,version,updated_at) VALUES('former_member','audio','track',1000,1,1,?)",
    )
    .bind(at)
    .run();
  const originalPrepare = db.prepare;
  let reads = 0;
  db.prepare = (sql) => {
    reads++;
    return originalPrepare(sql);
  };
  let batched;
  try {
    batched = await call(`/social/groups/${group}`, "GET", undefined, "bob");
  } finally {
    db.prepare = originalPrepare;
  }
  assert.ok(reads < 15, `group progress must batch readers; observed ${reads} queries`);
  assert.deepEqual(
    Object.fromEntries(batched.progress[0].buckets.map((b) => [b.bucket, b.count])),
    { not_started: 1, middle: 41, late: 1 },
    "removed members do not contribute",
  );
  await db
    .prepare("UPDATE audio_editions SET epub_sha256=? WHERE id='audio'")
    .bind("b".repeat(64))
    .run();
  assert.equal(
    (await call("/social/reader/1342?mode=public&progress=1", "GET", undefined, "bob")).indicators
      .length,
    0,
    "mismatched text/audio must fail closed",
  );
  await social.recordReadingProgress(db, "bob", product, { source: "ebook", progress: 0.8 });
  await social.recordReadingProgress(db, "bob", product, { source: "ebook", progress: 0.1 });
  assert.equal(
    (await call("/social/reader/1342?mode=public&progress=0", "GET", undefined, "bob")).progress,
    0.8,
    "returning to an earlier page cannot relock a reached passage",
  );
  // Real commercial publication sources and an immutable timing link exercise
  // batched reads, manifest identity and request-local caching together.
  const run = async (sql, ...values) =>
    db
      .prepare(sql)
      .bind(...values)
      .run();
  const audioProduct = (
    await db.prepare("SELECT id FROM products WHERE id<>? LIMIT 1").bind(product).first()
  ).id;
  const assetVersion = (
    await db
      .prepare(
        "SELECT da.current_version_id id FROM products p JOIN digital_assets da ON da.edition_id=p.edition_id WHERE p.id=? AND da.kind='epub'",
      )
      .bind(product)
      .first()
  ).id;
  const audioHash = "d".repeat(64);
  await run(
    "INSERT INTO publishing_accounts(id,account_type,legal_name,display_name,country_code,created_at,updated_at) VALUES('progress_fixture','person','Test Author','Test Author','US',?,?)",
    at,
    at,
  );
  async function seedSource(productId, prefix, sourceSnapshot) {
    const catalog = await db
      .prepare(
        "SELECT p.edition_id,e.work_id FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?",
      )
      .bind(productId)
      .first();
    await run(
      "INSERT INTO publishing_titles(id,account_id,title,created_at,updated_at) VALUES(?,'progress_fixture','Timing test',?,?)",
      prefix + "_title",
      at,
      at,
    );
    await run(
      "INSERT INTO publishing_edition_drafts(id,title_id,created_at,updated_at) VALUES(?,?,?,?)",
      prefix + "_draft",
      prefix + "_title",
      at,
      at,
    );
    await run(
      "INSERT INTO publishing_submission_snapshots(id,edition_id,account_id,revision,snapshot_json,snapshot_sha256,submitted_by_user_id,submitted_at) VALUES(?,?,'progress_fixture',1,'{}',?,'alice',?)",
      prefix + "_sub",
      prefix + "_draft",
      sha,
      at,
    );
    await run(
      "INSERT INTO publishing_publications(id,submission_id,publishing_account_id,work_id,edition_id,product_id,materialization_key,published_at) VALUES(?,?,'progress_fixture',?,?,?,?,?)",
      prefix + "_pub",
      prefix + "_sub",
      catalog.work_id,
      catalog.edition_id,
      productId,
      prefix + "_key",
      at,
    );
    await run(
      "INSERT INTO publishing_release_lifecycles(id,publishing_edition_id,current_publication_version_id,state,created_at,updated_at) VALUES(?,?,?,'live',?,?)",
      prefix + "_life",
      prefix + "_draft",
      prefix + "_version",
      at,
      at,
    );
    await run(
      "INSERT INTO publishing_publication_versions(id,lifecycle_id,publication_id,submission_id,version_number,snapshot_sha256,manifest_json,release_state,created_by_user_id,created_at) VALUES(?,?,?,?,1,?,?,'live','alice',?)",
      prefix + "_version",
      prefix + "_life",
      prefix + "_pub",
      prefix + "_sub",
      sha,
      JSON.stringify({ sourceSnapshot }),
      at,
    );
  }
  await seedSource(product, "ebook", {
    assets: [{ kind: "manuscript", current_version_id: assetVersion }],
  });
  await seedSource(audioProduct, "audio", { commercialAudioManifestSha256: audioHash });
  const timing = JSON.stringify({
    schemaVersion: 1,
    ebookProductId: product,
    audiobookProductId: audioProduct,
    ebookAssetVersionId: assetVersion,
    audioManifestSha256: audioHash,
    cues: [{ chapterId: "chapter", startMs: 0, endMs: 1000000, progress: 0.25, endProgress: 0.75 }],
  });
  const timingHash = createHash("sha256").update(timing).digest("hex");
  await env.BUCKET.put("test/commercial-timing.json", Buffer.from(timing));
  await run(
    "INSERT INTO commercial_biosync_links(id,ebook_product_id,audiobook_product_id,ebook_asset_version_id,audio_manifest_hash,timing_manifest_object_key,timing_manifest_sha256,precision,coverage_bps,verification_status,verified_by,verified_at,created_at) VALUES('commercial_link',?,?,?,?,?,?, 'sentence',10000,'verified','test_verifier',?,?)",
    product,
    audioProduct,
    assetVersion,
    audioHash,
    "test/commercial-timing.json",
    timingHash,
    at,
    at,
  );
  for (const [user, seconds] of [
    ["alice", 300],
    ["bob", 500],
    ["former_member", 1000],
  ])
    await run(
      "INSERT INTO commercial_audio_playback(user_id,product_id,chapter_id,seconds,updated_at) VALUES(?,?,'chapter',?,?)",
      user,
      audioProduct,
      seconds,
      at,
    );
  await run(
    "INSERT INTO commercial_biosync_positions(user_id,biosync_link_id,mode,cfi,chapter_id,audio_ms,updated_at) VALUES('charlie','commercial_link','audio','epubcfi(/6/2!)','chapter',1000000,?)",
    at,
  );
  const getObject = env.BUCKET.get;
  let objectReads = 0;
  env.BUCKET.get = async (...args) => {
    objectReads++;
    return getObject(...args);
  };
  const commercial = await spoilerProgress.savedGroupAlignedAudioProgress(
    db,
    group,
    product,
    env.BUCKET,
  );
  assert.equal(commercial.get("bob"), 0.25);
  assert.equal(commercial.get("charlie"), 0.75);
  assert.equal(commercial.has("former_member"), false);
  assert.equal(objectReads, 1, "one checked manifest read for all members and both audio sources");
  assert.equal(
    await spoilerProgress.savedAlignedAudioProgress(db, "bob", product, env.BUCKET),
    0.25,
  );
  await run(
    "UPDATE commercial_audio_playback SET seconds=? WHERE user_id='bob' AND product_id=?",
    Infinity,
    audioProduct,
  );
  assert.equal(
    await spoilerProgress.savedAlignedAudioProgress(db, "bob", product, env.BUCKET),
    0,
    "non-finite saved audio must fail closed",
  );
  await env.BUCKET.put("test/commercial-timing.json", Buffer.from(timing + " "));
  assert.equal(
    (await spoilerProgress.savedGroupAlignedAudioProgress(db, group, product, env.BUCKET)).get(
      "charlie",
    ) ?? 0,
    0,
    "tampered manifest is not reused across requests",
  );
  await env.BUCKET.put("test/commercial-timing.json", Buffer.from(timing));
  await run(
    "UPDATE publishing_release_lifecycles SET current_publication_version_id='missing' WHERE id='ebook_life'",
  );
  assert.equal(
    (await spoilerProgress.savedGroupAlignedAudioProgress(db, group, product, env.BUCKET)).get(
      "charlie",
    ) ?? 0,
    0,
    "a stale current ebook source cannot authorize the old timing map",
  );
  const originalBatch = db.batch;
  let race = true;
  db.batch = async (statements) => {
    if (race) {
      race = false;
      await db
        .prepare("UPDATE social_posts SET body='Winning edit',version=version+1 WHERE id='spoiler'")
        .run();
    }
    return originalBatch(statements);
  };
  try {
    await assert.rejects(
      call("/social/posts/spoiler", "PATCH", { body: "Losing edit", expectedVersion: 1 }),
      /changed/,
    );
  } finally {
    db.batch = originalBatch;
  }
  assert.equal(
    (await db.prepare("SELECT body FROM social_posts WHERE id='spoiler'").first()).body,
    "Winning edit",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) c FROM social_post_revisions WHERE post_id='spoiler'")
        .first()
    ).c,
    0,
    "a lost optimistic race cannot create a phantom revision",
  );
  console.log(
    "PASS: explicit bearer opt-in, member-bound JSON/SVG access, revocation/CAS, density zero, caller-progress rejection, aligned audio group/margin progress, and stale-alignment rejection.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
