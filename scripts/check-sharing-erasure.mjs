import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-sharing-erasure-"));
const originalFetch = globalThis.fetch;
try {
  fs.cpSync("drizzle", path.join(scratch, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "api.server",
      "social.server",
      "account-management.server",
      "account-erasure.server",
      "catalog-model.server",
    ].map((x) => `src/features/fore/${x}.ts`),
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: scratch,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  await build({
    entryPoints: ["supabase/functions/cove-account-erasure/handler.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(scratch, "bridge.mjs"),
    logLevel: "silent",
  });
  const api = await import(path.join(scratch, "api.server.mjs"));
  const social = await import(path.join(scratch, "social.server.mjs"));
  const account = await import(path.join(scratch, "account-management.server.mjs"));
  const erasure = await import(path.join(scratch, "account-erasure.server.mjs"));
  const bridge = await import(path.join(scratch, "bridge.mjs"));
  const catalog = await import(path.join(scratch, "catalog-model.server.mjs"));
  const env = localBindings(scratch),
    db = env.DB,
    at = new Date().toISOString();
  const request = (route, method = "GET", body, user = "alice") =>
    new Request(`https://fore.test/api/fore${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-id": user,
        "oai-authenticated-user-email": `${user}@test.invalid`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (route, method = "GET", body, user = "alice") => {
    const response = await social.handleSocial(
      request(route, method, body, user),
      env,
      route.split("?")[0],
      user,
    );
    assert.ok(response, route);
    assert.ok(response.ok, `${route}: ${response.status}`);
    return response.json();
  };
  await api.handleCoveApi(request("/catalog?q=pride"), env);
  for (const invalid of ["NaN", "0", "101", "2.5"])
    assert.equal(
      (await api.handleCoveApi(request(`/social/feed?limit=${invalid}`), env)).status,
      400,
    );

  for (const user of ["alice", "bob", "charlie"]) {
    await db
      .prepare(
        "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(user, user, `${user}@test.invalid`, user, at)
      .run();
    await call("/social/me", "GET", undefined, user);
  }
  const product = (
    await db.prepare("SELECT id FROM products WHERE source_external_id='1342'").first()
  ).id;
  await db
    .prepare(
      "INSERT INTO reading_states(user_id,product_id,external_book_id,progress,cfi,updated_at) VALUES('bob',?,'1342',0.1,'',?),('alice',?,'1342',0.1,'',?)",
    )
    .bind(product, at, product, at)
    .run();
  const group = (
    await call("/social/groups", "POST", { name: "Private club", visibility: "private" })
  ).id;
  await db
    .prepare(
      "INSERT INTO reading_group_members(group_id,user_id,role,status,joined_at,created_at,updated_at) VALUES(?,'bob','member','active',?,?,?)",
    )
    .bind(group, at, at, at)
    .run();
  const post = {
    contextType: "margin",
    contextId: "1342",
    bookId: "1342",
    cfi: "epubcfi(/6/2!)",
    chapter: "Chapter 1",
    progress: 0.1,
    passageText: "A passage",
    body: "Our group discussion",
    visibility: "group",
    audienceConfirmed: true,
    groupId: group,
  };
  await assert.rejects(
    call("/social/posts", "POST", { ...post, audienceConfirmed: false }),
    /Confirm the audience/,
  );
  const groupPost = await call("/social/posts", "POST", post);
  assert.equal(
    (await db.prepare("SELECT group_id FROM social_posts WHERE id=?").bind(groupPost.id).first())
      .group_id,
    group,
  );
  const reader = await call(
    `/social/reader/1342?mode=group&groupId=${group}&progress=1`,
    "GET",
    undefined,
    "bob",
  );
  assert.ok(reader.indicators.flatMap((x) => x.posts).some((x) => x.id === groupPost.id));
  const repeatedWords = await call("/social/posts", "POST", {
    ...post,
    cfi: "epubcfi(/6/4!)",
    chapter: "Chapter 2",
    body: "The same words in another chapter",
  });
  const locations = (
    await call(`/social/reader/1342?mode=group&groupId=${group}`, "GET", undefined, "bob")
  ).indicators;
  const firstLocation = locations.find((cluster) =>
    cluster.posts.some((p) => p.id === groupPost.id),
  );
  const secondLocation = locations.find((cluster) =>
    cluster.posts.some((p) => p.id === repeatedWords.id),
  );
  assert.notEqual(
    firstLocation.passageHash,
    secondLocation.passageHash,
    "identical quotations at different CFIs must not collapse into one marker",
  );
  assert.notEqual(firstLocation.cfi, secondLocation.cfi);
  for (const state of ["suspended", "deleted"]) {
    await db
      .prepare(
        state === "suspended"
          ? "UPDATE reading_groups SET status='suspended' WHERE id=?"
          : "UPDATE reading_groups SET deleted_at='2026-01-01' WHERE id=?",
      )
      .bind(group)
      .run();
    const unavailableGroup = await call(
      `/social/posts?contextType=margin&contextId=1342&postId=${groupPost.id}`,
      "GET",
      undefined,
      "bob",
    );
    assert.equal(
      unavailableGroup.posts.length,
      0,
      "a stale membership cannot expose a suspended/deleted group's margin posts",
    );
    await assert.rejects(call("/social/posts", "POST", post), /Select a group/);
    await db
      .prepare("UPDATE reading_groups SET status='active',deleted_at=NULL WHERE id=?")
      .bind(group)
      .run();
  }

  await assert.rejects(call("/social/posts", "POST", { ...post, groupId: null }), /Select a group/);
  await assert.rejects(call("/social/posts", "POST", post, "charlie"), /Select a group/);
  await assert.rejects(
    call(`/social/reader/1342?mode=group&groupId=${group}&progress=1`, "GET", undefined, "charlie"),
    /Join this group/,
  );
  const reply = await call(
    "/social/posts",
    "POST",
    { ...post, postType: "reply", parentId: groupPost.id, visibility: "public", groupId: null },
    "bob",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT group_id,visibility FROM social_posts WHERE id=?")
        .bind(reply.id)
        .first()
    ).visibility,
    "group",
  );
  const saved = await (
    await api.handleCoveApi(
      request("/annotations", "POST", {
        bookId: "1342",
        quote: "Private excerpt",
        note: "Private note",
        cfi: "epubcfi(/6/4!)",
        chapter: "Chapter 2",
        color: "yellow",
        progress: 0.5,
      }),
      env,
    )
  ).json();
  assert.ok(saved.id);
  let noteVersion = saved.version;
  const shareRoute = `/social/highlights/${saved.id}/share`;
  assert.equal((await call("/social/members?username=@bob")).member.id, "bob");
  await db
    .prepare(
      "UPDATE social_profiles SET profile_visibility='private',bio='Private biography' WHERE user_id='bob'",
    )
    .run();
  await db.prepare("UPDATE profiles SET name='Private real name' WHERE user_id='bob'").run();
  const privateMember = (await call("/social/members?username=@bob")).member;
  assert.equal(privateMember.name, "bob");
  assert.equal(privateMember.bio, undefined);

  await assert.rejects(
    call(shareRoute, "POST", {
      visibility: "friends",
      shareNote: true,
      audienceConfirmed: true,
    }),
    /Review the current private note/,
  );
  await assert.rejects(
    social.handleSocial(
      request(shareRoute, "POST", {
        visibility: "member",
        recipientUserId: "bob",
        shareNote: true,
        expectedAnnotationVersion: noteVersion,
      }),
      env,
      shareRoute,
      "alice",
    ),
    /Confirm the highlight audience/,
  );
  await call(shareRoute, "POST", {
    audienceConfirmed: true,
    visibility: "member",
    recipientUserId: "bob",
    shareNote: true,
    expectedAnnotationVersion: noteVersion,
  });
  assert.equal((await call(shareRoute)).visibility, "member");
  const originalVersion = (await call(shareRoute)).version;
  await call(shareRoute, "POST", {
    audienceConfirmed: true,
    visibility: "member",
    recipientUserId: "bob",
    shareNote: true,
    expectedAnnotationVersion: noteVersion,
    expectedVersion: originalVersion,
  });
  await assert.rejects(
    call(shareRoute, "POST", {
      audienceConfirmed: true,
      visibility: "public",
      expectedVersion: originalVersion,
    }),
    /Sharing changed/,
  );
  await assert.rejects(
    call(shareRoute, "DELETE", { expectedVersion: originalVersion }),
    /Sharing changed/,
  );
  const inventory = (user, view = "received", cursor) =>
    call(
      `/social/sharing?view=${view}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      "GET",
      undefined,
      user,
    );
  let inbox = await inventory("bob");
  const locked = inbox.items.find((x) => x.id === saved.id);
  assert.equal(locked.locked, true);
  assert.equal(locked.quote, undefined);
  assert.equal(locked.note, undefined);
  assert.equal(locked.cfi, undefined);
  assert.ok(!(await inventory("charlie")).items.some((x) => x.id === saved.id));
  await db
    .prepare(
      "INSERT OR REPLACE INTO reading_states(user_id,product_id,external_book_id,progress,cfi,updated_at) VALUES(?,?,?,1,'',?)",
    )
    .bind("bob", product, "1342", at)
    .run();
  inbox = await inventory("bob");
  assert.equal(inbox.items.find((x) => x.id === saved.id).note, "Private note");
  const privateEdit = await api.handleCoveApi(
    request(`/annotations/${saved.id}`, "PATCH", {
      note: "Edited private note",
      color: "yellow",
      expectedVersion: saved.version,
    }),
    env,
  );
  assert.equal(privateEdit.status, 200);
  noteVersion = (await privateEdit.json()).version;
  assert.equal(
    (await inventory("bob")).items.find((x) => x.id === saved.id).note,
    "Private note",
    "editing the private annotation must not silently mutate the published snapshot",
  );
  await assert.rejects(
    call(shareRoute, "POST", {
      visibility: "friends",
      shareNote: true,
      audienceConfirmed: true,
      expectedAnnotationVersion: noteVersion - 1,
    }),
    /private note changed/,
  );
  await assert.rejects(
    call(`/social/highlights/${saved.id}/republish-note`, "POST", {
      confirmed: true,
      expectedAnnotationVersion: noteVersion - 1,
      shares: (await call(shareRoute)).shares
        .filter((share) => share.shareNote)
        .map((share) => ({ id: share.id, version: share.version })),
    }),
    /private note changed/,
  );
  const raceCreated = await call(shareRoute, "POST", {
    visibility: "friends",
    shareNote: true,
    audienceConfirmed: true,
    expectedAnnotationVersion: noteVersion,
    expectedVersion: 0,
  });
  await assert.rejects(
    call(shareRoute, "POST", {
      visibility: "friends",
      shareNote: false,
      audienceConfirmed: true,
      expectedVersion: 0,
    }),
    /Sharing changed/,
  );
  assert.equal(
    (await call(shareRoute)).shares.find((share) => share.id === raceCreated.shareId).shareNote,
    true,
  );
  await call(shareRoute, "DELETE", {
    shareId: raceCreated.shareId,
    expectedVersion: raceCreated.version,
  });
  const permissionSaveTarget = (await call(shareRoute)).shares.find(
    (share) => share.recipientUserId === "bob",
  );
  await call(shareRoute, "POST", {
    audienceConfirmed: true,
    shareId: permissionSaveTarget.id,
    expectedVersion: permissionSaveTarget.version,
    visibility: "member",
    recipientUserId: "bob",
    shareNote: true,
    expectedAnnotationVersion: noteVersion,
  });
  assert.equal(
    (await inventory("bob")).items.find((x) => x.id === saved.id).note,
    "Private note",
    "saving unchanged sharing permissions must preserve the published snapshot",
  );
  const unrepublishedMargin = await call(
    "/social/reader/1342?mode=friends&progress=1",
    "GET",
    undefined,
    "bob",
  );
  assert.equal(
    unrepublishedMargin.indicators
      .flatMap((indicator) => indicator.highlights)
      .find((highlight) => highlight.annotationId === saved.id)?.note,
    "Private note",
    "the reader margin must render the published snapshot, not the edited private note",
  );
  const republishRoute = `/social/highlights/${saved.id}/republish-note`,
    publishedShares = (await call(shareRoute)).shares.filter((share) => share.shareNote);
  await assert.rejects(
    call(republishRoute, "POST", {
      confirmed: true,
      expectedAnnotationVersion: noteVersion,
      shares: publishedShares.map((share) => ({ id: share.id, version: share.version + 1 })),
    }),
    /changed/,
  );
  assert.equal(
    (await inventory("bob")).items.find((x) => x.id === saved.id).note,
    "Private note",
    "stale republish must not partially update a publication",
  );
  await call(republishRoute, "POST", {
    confirmed: true,
    expectedAnnotationVersion: noteVersion,
    shares: publishedShares.map((share) => ({ id: share.id, version: share.version })),
  });
  assert.equal(
    (await inventory("bob")).items.find((x) => x.id === saved.id).note,
    "Edited private note",
    "published notes change only after explicit, version-checked republishing",
  );
  const margin = await call("/social/reader/1342?mode=friends&progress=1", "GET", undefined, "bob");
  const republishedMarginNote = margin.indicators
    .flatMap((indicator) => indicator.highlights)
    .find((highlight) => highlight.annotationId === saved.id)?.note;
  assert.equal(republishedMarginNote, "Edited private note");
  assert.ok(
    margin.indicators
      .flatMap((x) => x.highlights)
      .some((x) => x.id === saved.id || x.annotationId === saved.id),
  );
  assert.ok(
    !(await call("/social/reader/1342?mode=public&progress=1", "GET", undefined, "bob")).indicators
      .flatMap((x) => x.highlights)
      .some((x) => x.id === saved.id || x.annotationId === saved.id),
  );
  assert.ok(
    !(await call("/social/feed", "GET", undefined, "bob")).items.some(
      (x) => x.entity_id === saved.id,
    ),
  );
  await assert.rejects(call(shareRoute, "DELETE", {}, "charlie"), /Highlight not found/);
  await call(shareRoute, "POST", {
    audienceConfirmed: true,
    visibility: "member",
    recipientUserId: "bob",
    shareNote: false,
  });
  assert.equal((await inventory("bob")).items.find((x) => x.id === saved.id).note, "");
  await call(shareRoute, "POST", {
    audienceConfirmed: true,
    visibility: "member",
    recipientUserId: "charlie",
    shareNote: true,
    expectedAnnotationVersion: noteVersion,
  });
  const simultaneousShares = (await call(shareRoute)).shares,
    bobShare = simultaneousShares.find((share) => share.recipientUserId === "bob"),
    charlieShare = simultaneousShares.find((share) => share.recipientUserId === "charlie");
  assert.ok(bobShare && charlieShare, "one highlight can have independent simultaneous audiences");
  assert.ok((await inventory("bob")).items.some((x) => x.id === saved.id));
  assert.ok((await inventory("charlie")).items.some((x) => x.id === saved.id));
  await call(shareRoute, "DELETE", {
    shareId: bobShare.id,
    expectedVersion: bobShare.version,
  });
  assert.ok(!(await inventory("bob")).items.some((x) => x.id === saved.id));
  assert.ok((await inventory("charlie")).items.some((x) => x.id === saved.id));
  await call(shareRoute, "DELETE", {});
  assert.ok(!(await inventory("charlie")).items.some((x) => x.id === saved.id));
  await call("/social/sharing/preferences", "POST", { policy: "none" }, "bob");
  await assert.rejects(
    call(shareRoute, "POST", {
      audienceConfirmed: true,
      visibility: "member",
      recipientUserId: "bob",
    }),
    /not accepting shares/,
  );
  await call("/social/sharing/preferences", "POST", { policy: "members" }, "bob");
  await call("/social/block", "POST", { userId: "alice", blocked: true }, "bob");
  await assert.rejects(
    call(shareRoute, "POST", {
      audienceConfirmed: true,
      visibility: "member",
      recipientUserId: "bob",
    }),
    /not accepting shares/,
  );
  await call("/social/block", "POST", { userId: "alice", blocked: false }, "bob");
  const direct = await call("/social/posts", "POST", {
    ...post,
    visibility: "member",
    groupId: null,
    recipientUserId: "bob",
    body: "A direct thought",
  });
  assert.equal(
    (
      await db
        .prepare("SELECT recipient_user_id,visibility FROM social_posts WHERE id=?")
        .bind(direct.id)
        .first()
    ).recipient_user_id,
    "bob",
  );
  assert.ok((await inventory("bob")).items.some((x) => x.id === direct.id));
  await assert.rejects(
    call(
      "/social/posts",
      "POST",
      { ...post, parentId: direct.id, visibility: "public" },
      "charlie",
    ),
    /Reply target/,
  );
  const directReply = await call(
    "/social/posts",
    "POST",
    { ...post, parentId: direct.id, visibility: "public" },
    "bob",
  );
  const persisted = await db
    .prepare("SELECT recipient_user_id,visibility,group_id FROM social_posts WHERE id=?")
    .bind(directReply.id)
    .first();
  assert.equal(persisted.recipient_user_id, "alice");
  assert.equal(persisted.visibility, "private");
  assert.equal(persisted.group_id, null);
  const conversation = await call("/social/posts?contextType=margin&contextId=1342&progress=1");
  const privateReply = conversation.posts
    .flatMap((post) => post.replyItems || [])
    .find((reply) => reply.user?.id === "bob");
  assert.ok(privateReply);
  assert.equal(privateReply.user.name, "bob");
  assert.equal(privateReply.user.bio, undefined);
  await call(`/social/posts/${direct.id}`, "DELETE", { expectedVersion: 1 });
  assert.ok(!(await inventory("bob")).items.some((x) => x.id === direct.id));
  assert.ok(
    (
      await db
        .prepare("SELECT deleted_at FROM social_posts WHERE id=?")
        .bind(directReply.id)
        .first()
    ).deleted_at,
  );
  const publicPost = await call("/social/posts", "POST", {
    ...post,
    visibility: "public",
    groupId: null,
    body: "Public margin thought",
  });
  assert.ok((await call("/social/feed")).items.some((item) => item.entity_id === publicPost.id));
  await call(`/social/posts/${publicPost.id}`, "DELETE", { expectedVersion: 1 });
  assert.ok(!(await call("/social/feed")).items.some((item) => item.entity_id === publicPost.id));
  // Stable pagination cannot skip shares with identical timestamps.
  let firstSharedAnnotationId = "";
  for (let n = 0; n < 33; n++) {
    const id = crypto.randomUUID();
    if (n === 0) firstSharedAnnotationId = id;
    await db
      .prepare(
        "INSERT INTO annotations(id,user_id,book_id,book_title,author,cfi,chapter,quote,note,color,created_at,updated_at) VALUES(?,'alice','1342','Pride','','','',?,'','yellow',?,?)",
      )
      .bind(id, `Quote ${n}`, at, at)
      .run();
    await call(`/social/highlights/${id}/share`, "POST", {
      audienceConfirmed: true,
      visibility: "member",
      recipientUserId: "bob",
    });
  }
  await call(`/social/highlights/${firstSharedAnnotationId}/share`, "POST", {
    audienceConfirmed: true,
    visibility: "friends",
  });
  await db.prepare("UPDATE social_annotation_shares SET updated_at=?").bind(at).run();
  const first = await inventory("alice", "sent");
  assert.equal(first.items.length, 30);
  assert.ok(first.nextCursor);
  const second = await inventory("alice", "sent", first.nextCursor);
  assert.equal(
    new Set([...first.items, ...second.items].map((x) => `${x.kind}:${x.shareId || x.id}`)).size,
    first.items.length + second.items.length,
  );
  assert.ok(second.items.length >= 3);
  // External cleanup is a checkpointed operation, never a best-effort completion.
  const provider = crypto.randomUUID(),
    user = `sb:${provider}`,
    job = `delete_${crypto.randomUUID()}`;
  await db
    .prepare(
      "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,'erasure',?)",
    )
    .bind(provider, user, "erase@test.invalid", at)
    .run();
  await db
    .prepare(
      "INSERT INTO personal_imports(id,user_id,product_id,object_key,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(crypto.randomUUID(), user, product, `uploads/${user}/private.epub`, at)
    .run();
  await db
    .prepare(
      "INSERT INTO account_deletion_requests(id,user_id,status,requested_at,execute_after,confirmation_hash,created_at,updated_at) VALUES(?,?,'queued',?,'2000-01-01','hash',?,?)",
    )
    .bind(job, user, at, at, at)
    .run();
  const uploadId = `upload_${crypto.randomUUID()}`;
  assert.equal(
    catalog.personalImportStatements,
    undefined,
    "Private imports must never expose a shared D1 writer",
  );
  env.seedLocalPersonalImport({
    id: uploadId,
    userId: user,
    title: "Private imported title",
    author: "Private author",
    language: "en",
    objectKey: `uploads/${user}/true-private.epub`,
    createdAt: at,
  });
  const imported = await db
    .prepare("SELECT id,edition_id FROM products WHERE source_external_id=?")
    .bind(uploadId)
    .first();
  const privateEnv = { ...env, FORE_AUTH_MODE: "supabase", SUPABASE_URL: "https://identity.test" };
  assert.equal((await account.processAccountDeletionQueue(privateEnv)).completed, 0);
  assert.equal(
    (await db.prepare("SELECT status FROM account_deletion_requests WHERE id=?").bind(job).first())
      .status,
    "queued",
  );
  assert.equal(
    (await db.prepare("SELECT disabled_at FROM auth_accounts WHERE app_id=?").bind(user).first())
      .disabled_at,
    null,
    "missing configuration must not erase locally and pretend completion",
  );
  const retry = () =>
    db
      .prepare(
        "UPDATE account_deletion_requests SET next_retry_at=NULL,lease_expires_at=NULL WHERE id=?",
      )
      .bind(job)
      .run();
  await retry();
  await db
    .prepare(
      "UPDATE account_deletion_requests SET status='executing',lease_expires_at=?,lease_token='other-worker' WHERE id=?",
    )
    .bind(new Date(Date.now() + 600000).toISOString(), job)
    .run();
  assert.equal(
    (await account.processAccountDeletionQueue(privateEnv)).processed,
    0,
    "an active lease cannot be stolen",
  );
  await db
    .prepare("UPDATE account_deletion_requests SET lease_expires_at='2000-01-01' WHERE id=?")
    .bind(job)
    .run();
  let deletedObjects = 0;
  privateEnv.SUPABASE_SECRET_KEY = "test-only";
  privateEnv.BUCKET = {
    ...env.BUCKET,
    delete: async () => {
      deletedObjects++;
      throw new Error("R2 unavailable");
    },
  };
  assert.equal((await account.processAccountDeletionQueue(privateEnv)).completed, 0);
  let state = await db
    .prepare("SELECT * FROM account_deletion_requests WHERE id=?")
    .bind(job)
    .first();
  assert.equal(state.storage_erased_at, null);
  assert.ok(state.object_keys_json.includes("private.epub"));
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM personal_imports WHERE user_id=?").bind(user).first())
      .n,
    2,
  );
  await assert.rejects(call("/social/me", "GET", undefined, user), /being erased/);
  await retry();
  privateEnv.BUCKET.delete = async () => {
    deletedObjects++;
  };
  globalThis.fetch = async () => Response.json({ error: "denied" }, { status: 403 });
  assert.equal((await account.processAccountDeletionQueue(privateEnv)).completed, 0);
  state = await db.prepare("SELECT * FROM account_deletion_requests WHERE id=?").bind(job).first();
  assert.ok(state.storage_erased_at);
  assert.ok(state.database_erased_at);
  assert.equal(
    await db.prepare("SELECT id FROM products WHERE id=?").bind(imported.id).first(),
    null,
  );
  assert.equal(
    await db.prepare("SELECT id FROM editions WHERE id=?").bind(imported.edition_id).first(),
    null,
  );
  assert.ok(
    await db.prepare("SELECT id FROM products WHERE id=?").bind(product).first(),
    "public catalog must survive private account erasure",
  );
  assert.equal(state.identity_erased_at, null);
  assert.equal(state.completed_at, null);
  const afterStorage = deletedObjects;
  await retry();
  globalThis.fetch = async (_url, options) =>
    options?.method === "DELETE"
      ? Response.json({})
      : Response.json({ code: "user_not_found" }, { status: 404 });
  const done = await Promise.all([
    account.processAccountDeletionQueue(privateEnv),
    account.processAccountDeletionQueue(privateEnv),
  ]);
  assert.equal(
    done.reduce((n, r) => n + r.completed, 0),
    1,
  );
  assert.equal(deletedObjects, afterStorage, "retry must retain completed storage checkpoint");
  state = await db.prepare("SELECT * FROM account_deletion_requests WHERE id=?").bind(job).first();
  assert.equal(state.status, "completed");
  assert.ok(state.identity_erased_at);
  assert.ok(state.completed_at);
  const held = `delete_${crypto.randomUUID()}`;
  await db
    .prepare(
      "INSERT INTO account_deletion_requests(id,user_id,status,requested_at,execute_after,confirmation_hash,created_at,updated_at) VALUES(?,'alice','queued',?,'2000-01-01','hash',?,?)",
    )
    .bind(held, at, at, at)
    .run();
  assert.equal((await account.processAccountDeletionQueue(env)).blocked, 1);
  assert.equal(
    (await db.prepare("SELECT status FROM account_deletion_requests WHERE id=?").bind(held).first())
      .status,
    "blocked_legal_hold",
  );
  assert.equal(
    (await db.prepare("SELECT disabled_at FROM auth_accounts WHERE app_id='alice'").first())
      .disabled_at,
    null,
  );
  // The Supabase bridge rejects unsigned, expired, wrong-purpose and mismatched subjects.
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const privateKey = await crypto.subtle.exportKey("jwk", keys.privateKey),
    publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  let receipt;
  globalThis.fetch = async (_url, options) => {
    receipt = JSON.parse(options.body);
    return Response.json({ deleted: true, providerId: provider });
  };
  // Force the clock across a millisecond boundary between consecutive reads.
  // The strict bridge rejects a proof longer than 120000 ms even by 1 ms.
  const originalNow = Date.now;
  const issuedAt = originalNow();
  let clockReads = 0;
  Date.now = () => issuedAt + clockReads++;
  try {
    await erasure.eraseProviderIdentity(
      { ...privateEnv, FORE_INGESTION_SIGNING_KEY: JSON.stringify(privateKey) },
      provider,
      user,
      job,
    );
  } finally {
    Date.now = originalNow;
  }
  const proofClaims = JSON.parse(Buffer.from(receipt.payload, "base64url").toString("utf8"));
  assert.equal(proofClaims.issuedAt, issuedAt);
  assert.equal(proofClaims.expiresAt - proofClaims.issuedAt, 120000);
  let calls = 0;
  const bridgeRequest = (proof) =>
    new Request("https://edge.test", { method: "POST", body: JSON.stringify(proof) });
  assert.equal(
    (
      await bridge.handleErasure(bridgeRequest(receipt), publicKey, async (id) => {
        calls++;
        assert.equal(id, provider);
        return true;
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await bridge.handleErasure(
        bridgeRequest({ ...receipt, signature: "bad" }),
        publicKey,
        async () => {
          calls++;
          return true;
        },
      )
    ).status,
    401,
  );
  const claim = JSON.parse(Buffer.from(receipt.payload, "base64url").toString());
  const signed = async (change) => {
    const payload = Buffer.from(JSON.stringify({ ...claim, ...change })).toString("base64url");
    return {
      payload,
      signature: Buffer.from(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keys.privateKey,
          new TextEncoder().encode(erasure.ERASURE_SIGNATURE_CONTEXT + payload),
        ),
      ).toString("base64url"),
    };
  };
  for (const change of [
    { expiresAt: Date.now() - 1 },
    { action: "download" },
    { userId: "alice" },
    { providerId: crypto.randomUUID() },
    { issuedAt: Date.now() + 120000 },
    { requestId: "not-an-erasure-job" },
  ])
    assert.equal(
      (
        await bridge.handleErasure(bridgeRequest(await signed(change)), publicKey, async () => {
          calls++;
          return true;
        })
      ).status,
      401,
    );
  assert.equal(calls, 1);
  assert.equal(
    (await bridge.handleErasure(bridgeRequest(receipt), publicKey, async () => false)).status,
    503,
  );
  assert.equal(
    (
      await bridge.handleErasure(
        new Request("https://edge.test", { method: "POST", body: "x".repeat(13000) }),
        publicKey,
        async () => true,
      )
    ).status,
    401,
  );
  assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
  console.log(
    "PASS: group/member margins and replies, recipient-only notes, sender management, spoiler-safe inbox, blocks/preferences, stable pagination, staged erasure retries, concurrent leases, and authenticated Supabase deletion proof.",
  );
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(scratch, { recursive: true, force: true });
}
