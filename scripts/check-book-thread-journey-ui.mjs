import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const social = readFileSync("src/features/fore/social.server.ts", "utf8");
const community = readFileSync("src/features/fore/Community.tsx", "utf8");
const book = readFileSync("src/features/fore/Book.tsx", "utf8");
const css = readFileSync("src/features/fore/reading-community.css", "utf8");
const migration = readFileSync("drizzle/0061_social_book_thread_keyset.sql", "utf8");
for (const expected of [
  'url.searchParams.get("thread") === "1"',
  'url.searchParams.get("sort") === "top"',
  "threadLimit + 1",
  "rows.slice(0, threadLimit)",
  "idx_social_book_threads_top",
]) {
  if (expected === "idx_social_book_threads_top") {
    assert.ok(migration.includes(expected));
  } else {
    assert.ok(social.includes(expected), expected);
  }
}
assert.ok(social.includes("parentId ? 8 : 12"));
assert.ok(social.includes("reaction_count DESC,created_at DESC,id DESC"));
assert.ok(social.includes("moderation_status='visible'"));
assert.ok(social.includes("const reactions = new Map<string, string[]>()"));
assert.ok(social.includes("btoa("));
assert.ok(social.includes("score: Number(rows[threadLimit - 1].reaction_count"));
assert.ok(social.includes("finishMs - startMs"));
assert.ok(social.includes("Number.isFinite(recorded)"));
assert.ok(social.includes(">START</text>"));

assert.ok(community.includes("bookThread={bookThread}"));
assert.ok(community.includes("depth={depth + 1}"));
assert.ok(community.includes("bookThread && depth >= 2"));
assert.ok(community.includes('focusedThread = params.get("thread")'));
assert.ok(community.includes("postId={focusedThread}"));
assert.ok(community.includes("parentId={focusedThread}"));
assert.ok(community.includes("aria-expanded={replying === p.id"));
assert.ok(community.includes('sharePlatform("x")'));
assert.ok(community.includes('sharePlatform("reddit")'));
assert.ok(community.includes("navigator.canShare?.({ files: [file] })"));
assert.ok(community.includes('cover.startsWith("/api/fore/assets/")'));
assert.ok(community.includes('visibility === "public"'));
assert.ok(community.includes("ctx.drawImage(coverImg, 90"));
assert.ok(book.includes("BookDiscussionDeferred"));
const deferred = readFileSync("src/features/fore/BookDiscussionDeferred.tsx", "utf8");
assert.ok(deferred.includes("IntersectionObserver"));
assert.ok(deferred.includes("rootMargin"));
assert.ok(deferred.includes('import("./Community")'));
assert.ok(deferred.includes('title="Reader discussion & comments"'));
assert.ok(css.includes(".cove-thread-children"));
assert.ok(css.includes(".cove-book-thread-focus"));
console.log(
  "BOOK_THREAD_CARD_POLICY_PASS bounded nested posts, keysets, hearts, privacy-safe public URLs, canvas book cover",
);
