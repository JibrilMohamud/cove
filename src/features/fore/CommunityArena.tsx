import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BookOpen, Flame, MessageCircle, Swords, Trophy } from "lucide-react";
import { toast } from "sonner";
import { api, useAccount } from "./client";
import { ARENA_KINDS, makeArenaPost, type ArenaKind } from "./community-arena";

type ArenaItem = {
  id: string;
  kind: ArenaKind;
  bookId: string;
  body: string;
  spoiler: boolean;
  version: number;
  fire: number;
  clown: number;
  replies: number;
  myReactions?: string[];
  createdAt: string;
  user?: { id: string; username: string; name: string } | null;
};
type ArenaPageResult = { items: ArenaItem[]; nextCursor: string | null; rankingWindow: string };

function bookIdentifier(value: string): string | null {
  const raw = value.trim();
  if (!raw) return "";
  if (/^[A-Za-z0-9_-]{1,100}$/.test(raw)) return raw;
  const pathname = raw.replace(/^https?:\/\/[^/]+/i, "");
  const match = /^\/books\/([A-Za-z0-9_-]{1,100})(?:[/?#].*)?$/.exec(pathname);
  return match ? match[1] : null;
}

export function CommunityArena() {
  const { data, signIn } = useAccount();
  const [kind, setKind] = useState<ArenaKind>("take");
  const [body, setBody] = useState("");
  const [bookRef, setBookRef] = useState("");
  const [spoiler, setSpoiler] = useState(false);
  const [sort, setSort] = useState<"recent" | "trending">("recent");
  const [kindFilter, setKindFilter] = useState<"all" | ArenaKind>("all");
  const [busy, setBusy] = useState("");
  const [reporting, setReporting] = useState("");
  const [reportReason, setReportReason] = useState("spam");
  const [reportDetails, setReportDetails] = useState("");
  const mine = useQuery<{ profile: { profile_visibility: string; activity_visibility: string } }>({
    queryKey: ["arena-profile-permissions", data.user?.id],
    queryFn: () => api("/social/me"),
    enabled: !!data.user,
    staleTime: 60_000,
  });
  const publicProfile =
    mine.data?.profile?.profile_visibility === "public" &&
    mine.data?.profile?.activity_visibility === "public";
  const feed = useInfiniteQuery<ArenaPageResult>({
    queryKey: ["community-arena", data.user?.id, sort, kindFilter],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api(
        `/social/arena?sort=${sort}&kind=${kindFilter}${pageParam ? `&cursor=${encodeURIComponent(String(pageParam))}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
    staleTime: 30_000,
  });
  const items = feed.data?.pages.flatMap((page) => page.items) || [];

  async function publish() {
    if (!data.user) return signIn();
    if (!publicProfile || !body.trim() || busy) return;
    const bookId = bookIdentifier(bookRef);
    if (bookId === null) return toast.error("Enter a Cove book ID or a /books/… link.");
    if (kind === "matchup" && !/^A:\s*.+\nB:\s*.+/m.test(body))
      return toast.error("Start a matchup with A: and B: on separate lines.");
    setBusy("publish");
    try {
      await api("/social/posts", "POST", {
        contextType: "profile",
        contextId: data.user.id,
        postType: "prompt",
        body: makeArenaPost(kind, body, bookId),
        visibility: "public",
        spoiler,
      });
      setBody("");
      setBookRef("");
      setSpoiler(false);
      await feed.refetch();
      toast.success("Published to Community");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function vote(post: ArenaItem, target: "agree" | "funny") {
    if (!data.user) return signIn();
    if (busy) return;
    setBusy(post.id);
    try {
      const previous = post.myReactions || [];
      const active = !previous.includes(target);
      const other = target === "agree" ? "funny" : "agree";
      // Both choices reuse the existing supported reactions. On a choice
      // change, clear the old reaction first. No new voting write API.
      if (active && previous.includes(other))
        await api(`/social/posts/${encodeURIComponent(post.id)}/reaction`, "POST", {
          reaction: other,
          active: false,
        });
      await api(`/social/posts/${encodeURIComponent(post.id)}/reaction`, "POST", {
        reaction: target,
        active,
      });
      await feed.refetch();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function report(postId: string) {
    if (!data.user) return signIn();
    setBusy(postId);
    try {
      await api("/social/report", "POST", {
        subjectType: "social_post",
        subjectId: postId,
        reason: reportReason,
        details: reportDetails.trim(),
      });
      setReporting("");
      setReportDetails("");
      toast.success("Sent to Community moderation");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function remove(post: ArenaItem) {
    if (busy || !confirm("Remove this Community post and its replies?")) return;
    setBusy(post.id);
    try {
      await api(`/social/posts/${encodeURIComponent(post.id)}`, "DELETE", {
        expectedVersion: post.version || 1,
      });
      await feed.refetch();
      toast.success("Post removed");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="cove-arena">
      <header className="social-page-heading">
        <div>
          <span className="small-label">PUBLIC COMMUNITY · NO ACCOUNT NEEDED TO BROWSE</span>
          <h1>Hot Takes, Debates & Tournaments</h1>
          <p>
            Explore lively book opinions, take sides in literary debates, and vote in matchups.
            Sign in only when you want to contribute. Book pages keep their own reviews.
          </p>
        </div>
        <Flame size={40} aria-hidden="true" />
      </header>
      <div className="cove-arena-layout">
        <section className="community-settings-card cove-arena-composer">
          <h2>Start something</h2>
          {!data.user ? (
            <button className="button gold" onClick={signIn}>
              Sign in to participate
            </button>
          ) : mine.isLoading ? (
            <p className="muted">Checking Community privacy settings…</p>
          ) : !publicProfile ? (
            <p className="muted">
              Public Arena posts require a public reader profile and public activity visibility. You
              can change both in{" "}
              <a className="text-link" href="/community?tab=me">
                My profile settings
              </a>
              . Your private books, highlights, and reading position stay private.
            </p>
          ) : (
            <>
              <div className="cove-arena-kind" role="group" aria-label="Post format">
                <button
                  type="button"
                  className={kind === "take" ? "selected" : ""}
                  onClick={() => setKind("take")}
                >
                  <Flame size={16} /> Hot Take
                </button>
                <button
                  type="button"
                  className={kind === "debate" ? "selected" : ""}
                  onClick={() => setKind("debate")}
                >
                  <Swords size={16} /> Debate
                </button>
                <button
                  type="button"
                  className={kind === "matchup" ? "selected" : ""}
                  onClick={() => setKind("matchup")}
                >
                  <Trophy size={16} /> Matchup
                </button>
              </div>
              <label htmlFor="arena-body">
                {kind === "take"
                  ? "Your take"
                  : kind === "debate"
                    ? "Debate question or position"
                    : "Two contenders"}
              </label>
              <textarea
                id="arena-body"
                className="note-input"
                value={body}
                maxLength={11000}
                placeholder={
                  kind === "take"
                    ? "A popular book deserves more criticism because…"
                    : kind === "debate"
                      ? "Is a memorable ending more important than a perfect beginning?"
                      : "A: Book or character one\nB: Book or character two\nWhy should yours win?"
                }
                onChange={(e) => setBody(e.target.value)}
              />
              <label htmlFor="arena-book">Related Cove book (optional)</label>
              <input
                id="arena-book"
                className="note-input"
                value={bookRef}
                maxLength={240}
                placeholder="Book ID or Cove book link"
                onChange={(e) => setBookRef(e.target.value)}
              />
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={spoiler}
                  onChange={(e) => setSpoiler(e.target.checked)}
                />
                Hide behind a spoiler warning
              </label>
              <button
                className="button gold"
                disabled={!!busy || body.trim().length < 10}
                onClick={publish}
              >
                {busy === "publish" ? "Publishing…" : "Publish to Community"}
              </button>
            </>
          )}
          <p className="small muted">
            Tournament matchups use A/B voting. For larger brackets and multi-option polls, use your
            reading group's existing poll tools.
          </p>
        </section>
        <section className="cove-arena-feed">
          <div className="cove-arena-feed-heading">
            <h2>From the Community</h2>
            <div className="cove-arena-kind" role="group" aria-label="Community post categories">
              {([
                ["all", "All"],
                ["take", "Hot Takes"],
                ["debate", "Debates"],
                ["matchup", "Tournaments"],
              ] as const).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={kindFilter === key}
                  className={kindFilter === key ? "selected" : ""}
                  onClick={() => setKindFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="recent">Newest</option>
                <option value="trending">Trending (recent posts)</option>
              </select>
            </label>
          </div>
          {feed.isLoading && (
            <p className="muted" role="status">
              Loading Community posts…
            </p>
          )}
          {feed.isError && (
            <p role="alert">
              The Community feed could not load.{" "}
              <button onClick={() => feed.refetch()}>Retry</button>
            </p>
          )}
          {items.map((post) => {
            const fireName =
              post.kind === "matchup" ? "A" : post.kind === "debate" ? "Agree" : "🔥 Fire";
            const clownName =
              post.kind === "matchup" ? "B" : post.kind === "debate" ? "Disagree" : "🤡 Clown";
            const total = post.fire + post.clown;
            const balance =
              total >= 12 ? Math.round(100 * (1 - Math.abs(post.fire - post.clown) / total)) : null;
            return (
              <article className="cove-arena-card" key={post.id}>
                <header>
                  <span className="small-label">{ARENA_KINDS[post.kind]}</span>
                  <a
                    href={`/community?profile=${encodeURIComponent(post.user?.username || post.user?.id || "")}`}
                  >
                    {post.user?.name || "Reader"}
                  </a>
                  <time dateTime={post.createdAt}>
                    {new Date(post.createdAt).toLocaleDateString()}
                  </time>
                </header>
                {post.spoiler ? (
                  <details className="spoiler-disclosure">
                    <summary>Contains spoilers · reveal post</summary>
                    <p className="cove-arena-body">{post.body}</p>
                  </details>
                ) : (
                  <p className="cove-arena-body">{post.body}</p>
                )}
                {post.bookId && (
                  <a className="feed-book" href={`/books/${encodeURIComponent(post.bookId)}`}>
                    <BookOpen size={17} /> Related book
                  </a>
                )}
                <div className="cove-arena-votes" aria-label="Community reactions">
                  <button
                    type="button"
                    aria-pressed={(post.myReactions || []).includes("agree")}
                    className={(post.myReactions || []).includes("agree") ? "selected" : ""}
                    disabled={!!busy}
                    onClick={() => vote(post, "agree")}
                  >
                    {fireName} · {post.fire}
                  </button>
                  <button
                    type="button"
                    aria-pressed={(post.myReactions || []).includes("funny")}
                    className={(post.myReactions || []).includes("funny") ? "selected" : ""}
                    disabled={!!busy}
                    onClick={() => vote(post, "funny")}
                  >
                    {clownName} · {post.clown}
                  </button>
                </div>
                {balance !== null && (
                  <p className="small muted">
                    {balance}% disagreement balance · 12+ reactions
                  </p>
                )}
                <footer>
                  <a
                    className="text-link"
                    href={`/community?arenaPost=${encodeURIComponent(post.id)}&arenaOwner=${encodeURIComponent(post.user?.id || "")}`}
                  >
                    <MessageCircle size={15} /> {post.replies} replies
                  </a>
                  {data.user?.id === post.user?.id ? (
                    <button
                      type="button"
                      className="text-link"
                      disabled={!!busy}
                      onClick={() => remove(post)}
                    >
                      Delete
                    </button>
                  ) : (
                    data.user && (
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => setReporting(reporting === post.id ? "" : post.id)}
                      >
                        Report
                      </button>
                    )
                  )}
                </footer>
                {reporting === post.id && (
                  <div className="cove-arena-report">
                    <label>
                      Reason
                      <select
                        value={reportReason}
                        onChange={(e) => setReportReason(e.target.value)}
                      >
                        <option value="spam">Spam</option>
                        <option value="harassment">Harassment</option>
                        <option value="scam">Scam</option>
                        <option value="misleading">Misleading content</option>
                        <option value="other">Other</option>
                      </select>
                    </label>
                    <textarea
                      className="note-input"
                      value={reportDetails}
                      maxLength={5000}
                      aria-label="Report details"
                      onChange={(e) => setReportDetails(e.target.value)}
                    />
                    <button
                      className="button outline"
                      disabled={!!busy || (reportReason === "other" && !reportDetails.trim())}
                      onClick={() => report(post.id)}
                    >
                      Send report
                    </button>
                  </div>
                )}
              </article>
            );
          })}
          {!feed.isLoading && !feed.isError && !items.length && (
            <p className="muted">
              No public Arena posts in this window yet. Start the first one, or load older Community
              activity.
            </p>
          )}
          {feed.hasNextPage && (
            <button
              className="button outline"
              disabled={feed.isFetchingNextPage}
              onClick={() => feed.fetchNextPage()}
            >
              {feed.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
        </section>
      </div>
    </section>
  );
}
