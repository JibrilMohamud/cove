// Opt-in, authenticated seed of a small public Community launch set.
// Requires explicit operator consent. No SQL and no privileged session bypass.
// Never print credentials, cookie values or provider authentication errors.
import assert from "node:assert/strict";
import fs from "node:fs";

const email = process.env.COVE_QA_OUTSIDER_EMAIL || "";
const password = process.env.COVE_QA_OUTSIDER_PASSWORD || "";
const target = process.env.COVE_QA_SEED_TARGET || "";
assert.ok(
  email.includes("@") && password.length,
  "QA outsider credentials must be supplied securely",
);
assert.equal(
  process.env.COVE_QA_SEED_CONFIRM,
  "publish-six-public-posts",
  "Explicit QA publication confirmation is required",
);
const origin = new URL(target);
assert.equal(origin.protocol, "https:", "Never transmit QA credentials over HTTP");
assert.ok(
  origin.hostname === "cove-jibrilmohamuds-projects.vercel.app" ||
    origin.hostname === "covereads.com" ||
    origin.hostname === "www.covereads.com" ||
    /^cove-[a-z0-9-]+-jibrilmohamuds-projects\.vercel\.app$/.test(origin.hostname),
  "Only known Cove deployment hosts are permitted",
);
assert.equal(origin.pathname, "/", "Use a Cove origin, not a path");
const jar = new Map();

async function request(path, method = "GET", body) {
  const response = await fetch(new URL("/api/fore" + path, origin), {
    method,
    redirect: "error",
    headers: {
      "content-type": "application/json",
      origin: origin.origin,
      ...(jar.size ? { cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  for (const raw of response.headers.getSetCookie?.() || []) {
    const token = raw.split(";")[0] || "";
    const split = token.indexOf("=");
    if (split < 1) continue;
    const key = token.slice(0, split),
      value = token.slice(split + 1);
    if (!value) jar.delete(key);
    else jar.set(key, value);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Error(`Cove ${method} ${path.split("?")[0]} returned HTTP ${response.status}`);
  return result;
}

const signedIn = await request("/auth/login", "POST", { login: email, password });
assert.equal(signedIn.signedIn, true, "Unable to authenticate QA outsider");
assert.ok(!signedIn.mfaRequired, "Complete MFA using the normal site UI before seeding");
const account = await request("/account");
assert.equal(account.user?.email?.toLowerCase(), email.toLowerCase(), "Account identity mismatch");
const userId = account.user.id;
let me = await request("/social/me");
// User-authorized QA account only: publicly posting requires a public social
// identity. Change ONLY the two visibility switches, retaining every other
// reader privacy default and using the existing authenticated profile API.
if (
  me.profile?.profile_visibility !== "public" ||
  me.profile?.activity_visibility !== "public"
) {
  const p = me.profile;
  await request("/social/profile", "POST", {
    bio: p.bio || "",
    profileVisibility: "public",
    followPolicy: p.follow_policy || "open",
    repliesPolicy: p.replies_policy || "following",
    activityVisibility: "public",
    journeyVisibilityDefault: p.journey_visibility_default || "private",
    highlightVisibilityDefault: p.highlight_visibility_default || "private",
    showCurrentlyReading: !!p.show_currently_reading,
    expectedVersion: Number(p.version || 1),
  });
  me = await request("/social/me");
}
assert.ok(
  me.profile?.profile_visibility === "public" && me.profile?.activity_visibility === "public",
  "QA identity could not enable public posts",
);
const fixture = JSON.parse(
  fs.readFileSync("scripts/fixtures/community-arena-starter-posts.json", "utf8"),
);
assert.equal(fixture.posts.length, 6);
const seen = new Set();
for (const kind of ["take", "debate", "matchup"]) {
  const list = await request("/social/arena?kind=" + kind);
  for (const post of list.items || []) if (post.user?.id === userId) seen.add(post.body);
}
let added = 0,
  skipped = 0;
for (const post of fixture.posts) {
  assert.ok(["take", "debate", "matchup"].includes(post.kind));
  assert.ok(post.text && post.text.length > 40);
  if (seen.has(post.text)) {
    skipped++;
    continue;
  }
  const marker = "[COVE-ARENA:" + post.kind + (post.bookId ? ":" + post.bookId : "") + "]\n";
  const result = await request("/social/posts", "POST", {
    contextType: "profile",
    contextId: userId,
    postType: "prompt",
    visibility: "public",
    spoiler: false,
    body: marker + post.text,
  });
  assert.ok(result.id, "Cove rejected an Arena post");
  added++;
}
console.log(`Cove Community starter posts: published ${added}, already present ${skipped}.`);
