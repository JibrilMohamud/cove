import { useEffect, useState } from "react";
import "./community-arena-experience.css";
import { OfficialTournament } from "./OfficialTournament";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  ChevronRight,
  Flame,
  MessageCircle,
  Plus,
  RefreshCw,
  Search,
  Trophy,
  Sparkles,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
type ArenaPageResult = {
  items: ArenaItem[];
  nextCursor: string | null;
  rankingWindow: string;
  activity?: { postId: string; side: "A" | "B"; createdAt: string }[];
};
type TakeTab = "debates" | "fire" | "clowns";
type TakeSort = "trending" | "recent" | "fire" | "clown" | "top";
type DebateFilter = "trending" | "fire" | "clown" | "new" | "top" | "following";

const PROMPTS: { title: string; question: string; kind: ArenaKind; tint: string }[] = [
  {
    title: "DEFEND YOUR FAVORITE",
    question: "Which book deserves a five-star rating that almost nobody agrees with?",
    kind: "debate",
    tint: "rose",
  },
  {
    title: "THE ONE YOU DNF'D",
    question: "Which beloved classic did you put down—and why?",
    kind: "take",
    tint: "amber",
  },
  {
    title: "HOTTEST LITERARY TAKE",
    question: "Is a brilliant ending enough to forgive a painfully slow beginning?",
    kind: "debate",
    tint: "violet",
  },
  {
    title: "PICK A SIDE",
    question: "Are morally gray protagonists more compelling than traditional heroes?",
    kind: "debate",
    tint: "blue",
  },
  {
    title: "THE OVERRATED SHELF",
    question: "Which wildly popular book didn't live up to its reputation?",
    kind: "take",
    tint: "orange",
  },
  {
    title: "ADAPTATION WARS",
    question: "What movie adaptation is actually better than the book?",
    kind: "debate",
    tint: "rose",
  },
  {
    title: "UNPOPULAR OPINION",
    question: "A three-star read can be more memorable than a five-star read. Agree?",
    kind: "take",
    tint: "violet",
  },
  {
    title: "THE GREAT REREAD",
    question: "Which book completely changed for you on a second reading?",
    kind: "take",
    tint: "blue",
  },
];

const VERIFIED_PUBLIC_COVERS: Record<string, string> = {
  "jane eyre": "/covers/1260.jpg",
  "pride and prejudice": "/covers/1342.jpg",
  frankenstein: "/covers/84.jpg",
  "moby dick": "/covers/2701.jpg",
};
const VERIFIED_COVER_IDS = new Set([
  "1260",
  "1342",
  "84",
  "2701",
  "11",
  "345",
  "174",
  "768",
  "64317",
]);

function bookIdentifier(value: string): string | null {
  const raw = value.trim();
  if (!raw) return "";
  if (/^[A-Za-z0-9_-]{1,100}$/.test(raw)) return raw;
  const pathname = raw.replace(/^https?:\/\/[^/]+/i, "");
  const match = /^\/books\/([A-Za-z0-9_-]{1,100})(?:[/?#].*)?$/.exec(pathname);
  return match ? match[1] : null;
}
function matchupNames(body: string): [string, string] {
  const a = /^A:\s*(.+)$/im.exec(body);
  const b = /^B:\s*(.+)$/im.exec(body);
  const title = (line: string | undefined) =>
    (line || "")
      .split(/\s+[—–]\s+|\s+-\s+/)[0]
      .trim()
      .slice(0, 90);
  return [title(a?.[1]) || "First book", title(b?.[1]) || "Second book"];
}
function bookCover(title: string): string | null {
  return (
    VERIFIED_PUBLIC_COVERS[
      title
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .trim()
    ] || null
  );
}
function timeAgo(iso: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(iso).getTime());
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return Math.floor(elapsed / 60_000) + "m ago";
  if (elapsed < 86_400_000) return Math.floor(elapsed / 3_600_000) + "h ago";
  return Math.floor(elapsed / 86_400_000) + "d ago";
}
function balancePercent(post: ArenaItem): number | null {
  const total = post.fire + post.clown;
  return total >= 12 ? Math.round(100 * (1 - Math.abs(post.fire - post.clown) / total)) : null;
}
function divisiveScore(post: ArenaItem): number {
  const n = post.fire + post.clown;
  const balance = n ? 1 - Math.abs(post.fire - post.clown) / n : 0;
  // The first few votes cannot create an artificially high divisiveness rank.
  const confidence = Math.min(1, n / 12);
  const ageHours = Math.max(0, (Date.now() - Date.parse(post.createdAt)) / 3_600_000);
  return (
    (balance * confidence * 6 + Math.log1p(n) * 0.3 + Math.log1p(post.replies) * 0.2) /
    (1 + ageHours / 120)
  );
}
function ReaderCover({ title, className = "" }: { title: string; className?: string }) {
  const src = bookCover(title);
  return (
    <span className={"cove-arena-book-cover " + className}>
      <span className="cove-arena-cover-fallback" aria-hidden="true">
        <BookOpen size={26} />
      </span>
      {src && (
        <img
          src={src}
          alt={"Cover of " + title}
          loading="lazy"
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
        />
      )}
    </span>
  );
}

export function CommunityArena({ fullPage = false }: { fullPage?: boolean }) {
  const { data, signIn } = useAccount();
  const [kind, setKind] = useState<ArenaKind>("take");
  const [body, setBody] = useState("");
  const [bookRef, setBookRef] = useState("");
  const [spoiler, setSpoiler] = useState(false);
  const [sort, setSort] = useState<TakeSort>("trending");
  const [debateFilter, setDebateFilter] = useState<DebateFilter>("trending");
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  useEffect(() => {
    const debounce = setTimeout(() => setSearchTerm(searchInput.trim().slice(0, 80)), 350);
    return () => clearTimeout(debounce);
  }, [searchInput]);
  function chooseDebateFilter(next: DebateFilter) {
    setDebateFilter(next);
    setTakeTab(next === "fire" ? "fire" : next === "clown" ? "clowns" : "debates");
    setSort(
      next === "new" || next === "following"
        ? "recent"
        : next === "top"
          ? "top"
          : next === "fire"
            ? "fire"
            : next === "clown"
              ? "clown"
              : "trending",
    );
  }
  const [takeTab, setTakeTab] = useState<TakeTab>("debates");
  const [promptOffset, setPromptOffset] = useState(0);
  const [busy, setBusy] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [bracketOpen, setBracketOpen] = useState(false);
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
    queryKey: [
      "community-arena",
      data.user?.id,
      sort === "recent" ? "recent" : sort === "top" ? "top" : "trending",
      takeTab === "debates" ? "all" : "take",
      fullPage ? searchTerm : "",
      fullPage && debateFilter === "following",
    ],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api(
        "/social/arena?sort=" +
          (sort === "recent" ? "recent" : sort === "top" ? "top" : "trending") +
          "&kind=" +
          (takeTab === "debates" ? "all" : "take") +
          (fullPage && searchTerm ? "&search=" + encodeURIComponent(searchTerm) : "") +
          (fullPage && debateFilter === "following" ? "&following=1" : "") +
          (pageParam ? "&cursor=" + encodeURIComponent(String(pageParam)) : ""),
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
    staleTime: 30_000,
  });
  const bracket = useQuery<ArenaPageResult>({
    queryKey: ["community-bracket", data.user?.id],
    queryFn: () => api("/social/arena?sort=recent&kind=matchup"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const matchups = bracket.data?.items || [];
  const headlineMatch = matchups[0];
  const allItems = (feed.data?.pages.flatMap((page) => page.items) || []).filter((post) => {
    if (post.kind === "matchup") return false;
    if (takeTab === "fire") return post.kind === "take" && post.fire >= post.clown;
    if (takeTab === "clowns") return post.kind === "take" && post.clown > post.fire;
    return true;
  });
  const items = [...allItems].sort((a, b) => {
    if (sort === "fire") return b.fire - a.fire || divisiveScore(b) - divisiveScore(a);
    if (sort === "clown") return b.clown - a.clown || divisiveScore(b) - divisiveScore(a);
    if (sort === "recent") return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (sort === "top") return b.fire + b.clown + b.replies - (a.fire + a.clown + a.replies);
    return divisiveScore(b) - divisiveScore(a);
  });
  const prompts = Array.from({ length: 5 }, (_, i) => PROMPTS[(promptOffset + i) % PROMPTS.length]);

  function openComposer(nextKind: ArenaKind = "take", prompt = "") {
    setKind(nextKind);
    setBody(prompt);
    setComposerOpen(true);
    // On narrow layouts the composer follows the main feed; make the action reachable.
    requestAnimationFrame(() =>
      document
        .getElementById("cove-arena-compose")
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }
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
      setComposerOpen(false);
      await Promise.all([feed.refetch(), bracket.refetch()]);
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
      if (active && previous.includes(other))
        await api("/social/posts/" + encodeURIComponent(post.id) + "/reaction", "POST", {
          reaction: other,
          active: false,
        });
      await api("/social/posts/" + encodeURIComponent(post.id) + "/reaction", "POST", {
        reaction: target,
        active,
      });
      await Promise.all([feed.refetch(), bracket.refetch()]);
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
      await api("/social/posts/" + encodeURIComponent(post.id), "DELETE", {
        expectedVersion: post.version || 1,
      });
      await Promise.all([feed.refetch(), bracket.refetch()]);
      toast.success("Post removed");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy("");
    }
  }
  const matchNames = headlineMatch ? matchupNames(headlineMatch.body) : null;
  const totalVotes = headlineMatch ? headlineMatch.fire + headlineMatch.clown : 0;
  const aPercent =
    headlineMatch && totalVotes ? Math.round((100 * headlineMatch.fire) / totalVotes) : 0;
  const bPercent = headlineMatch && totalVotes ? 100 - aPercent : 0;

  return (
    <section className={"cove-arena" + (fullPage ? " cove-arena-debates-page" : "")}>
      <header className="cove-arena-head">
        <div>
          <span className="cove-arena-eyebrow">
            <Sparkles size={13} />{" "}
            {fullPage ? "THE DISCOURSE / COVE COMMUNITY" : "THE READING ROOM / COVE COMMUNITY"}
          </span>
          {fullPage ? (
            <h1>
              Hot Takes. <em>Real conversations.</em>
            </h1>
          ) : (
            <h1 aria-label="Community">
              Good books. <em>Bold opinions.</em>
            </h1>
          )}
          <p>
            {fullPage
              ? "Find a debate, read the replies, and make your case."
              : "Make your case. Pick a side. Find your people."}
          </p>
        </div>
        <button type="button" className="cove-arena-primary" onClick={() => openComposer()}>
          <Plus size={18} /> Drop a hot take
        </button>
      </header>
      <div className="cove-arena-layout">
        <div className="cove-arena-main">
          {fullPage && (
            <section className="cove-debates-discovery" aria-label="Search and filter debates">
              <label className="cove-debates-search">
                <Search size={20} aria-hidden="true" />
                <span className="sr-only">Search recent public debates and comments</span>
                <input
                  type="search"
                  maxLength={80}
                  value={searchInput}
                  placeholder="Search takes, comments, readers, and books…"
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              </label>
              <div
                className="cove-debates-filters"
                role="group"
                aria-label="Debate discovery filters"
              >
                {(
                  [
                    ["trending", "Trending"],
                    ["fire", "Fire"],
                    ["clown", "Clownery"],
                    ["new", "New"],
                    ["top", "Top"],
                    ["following", "Following"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={debateFilter === value}
                    className={debateFilter === value ? "active" : ""}
                    onClick={() => chooseDebateFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>
          )}
          <section className="cove-arena-prompts" aria-labelledby="cove-prompt-heading">
            <div className="cove-arena-section-top">
              <h2 id="cove-prompt-heading">
                <Flame size={18} /> CONTROVERSY PROMPTS
              </h2>
              <button
                type="button"
                className="cove-arena-minor-action"
                onClick={() => setPromptOffset((n) => (n + 5) % PROMPTS.length)}
              >
                <RefreshCw size={14} /> Shuffle prompts
              </button>
            </div>
            <div className="cove-arena-prompt-grid">
              {prompts.map((prompt, index) => (
                <button
                  type="button"
                  key={prompt.title}
                  className={"cove-arena-prompt cove-arena-prompt-" + prompt.tint}
                  onClick={() => openComposer(prompt.kind, prompt.question)}
                >
                  <span className="cove-arena-prompt-kicker">
                    0{index + 1} / {prompt.title}
                  </span>
                  <strong>{prompt.question}</strong>
                  <span className="cove-arena-prompt-arrow">
                    Add your voice <ArrowRight size={17} />
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section className="cove-arena-feed" aria-labelledby="cove-takes-heading">
            <h2 className="small-label">Explore</h2>
            <div className="cove-arena-section-top cove-arena-takes-header">
              <div>
                <h2 id="cove-takes-heading">
                  <Flame size={19} /> HOT TAKES <span className="cove-arena-title-glow">/</span> THE
                  DISCOURSE
                </h2>
                <p>
                  {fullPage
                    ? "The newest arguments and opinions from Cove readers."
                    : "Bookish arguments worth staying up for."}
                </p>
              </div>
              <div className="cove-arena-feed-links">
                {!fullPage && (
                  <a className="cove-arena-minor-action" href="/community?tab=debates">
                    View debates <ArrowRight size={15} />
                  </a>
                )}
                <button
                  type="button"
                  className="cove-arena-minor-action"
                  onClick={() => openComposer("debate")}
                >
                  <Plus size={16} /> Start a debate
                </button>
              </div>
            </div>
            <div className="cove-arena-feed-toolbar">
              <div className="cove-arena-subtabs" role="tablist" aria-label="Hot Takes feed">
                {(
                  [
                    ["debates", "Active debates", "swords"],
                    ["fire", "Fire takes", "fire"],
                    ["clowns", "Clowns", "clown"],
                  ] as const
                ).map(([tab, label, glyph]) => (
                  <button
                    role="tab"
                    type="button"
                    key={tab}
                    aria-selected={takeTab === tab}
                    className={takeTab === tab ? "selected" : ""}
                    onClick={() => setTakeTab(tab)}
                  >
                    <span aria-hidden="true">
                      {glyph === "clown" ? "🤡" : glyph === "fire" ? "🔥" : "⚔"}
                    </span>{" "}
                    {label}
                  </button>
                ))}
              </div>
              <label className="cove-arena-sort">
                <span>Sort</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as TakeSort)}>
                  <option value="trending">Trending · Most divisive</option>
                  <option value="recent">Newest</option>
                  <option value="fire">Most fire</option>
                  <option value="clown">Most clowned</option>
                  <option value="top">Top engagement</option>
                </select>
              </label>
            </div>
            {feed.isLoading && (
              <p className="cove-arena-status" role="status">
                Gathering the latest opinions…
              </p>
            )}
            {feed.isError && (
              <p className="cove-arena-status" role="alert">
                Community posts could not load.{" "}
                <button className="text-link" onClick={() => feed.refetch()}>
                  Retry
                </button>
              </p>
            )}
            <div className="cove-arena-post-list" role="tabpanel" aria-label="Hot Takes posts">
              {items.map((post) => {
                const ratio = balancePercent(post);
                const chosenFire = (post.myReactions || []).includes("agree");
                const chosenClown = (post.myReactions || []).includes("funny");
                return (
                  <article className="cove-arena-card" key={post.id}>
                    <div className="cove-arena-card-content">
                      <header>
                        <span className="cove-arena-avatar" aria-hidden="true">
                          {(post.user?.name || "R").slice(0, 1).toUpperCase()}
                        </span>
                        <span className="cove-arena-byline">
                          <a
                            href={
                              "/community?profile=" +
                              encodeURIComponent(post.user?.username || post.user?.id || "")
                            }
                          >
                            {post.user?.name || "Reader"}
                          </a>
                          <small>
                            {timeAgo(post.createdAt)} · <span>{ARENA_KINDS[post.kind]}</span>
                          </small>
                        </span>
                        {ratio !== null && (
                          <span className="cove-arena-divisive-tag">{ratio}% DIVISIVE</span>
                        )}
                      </header>
                      {post.spoiler ? (
                        <details className="spoiler-disclosure">
                          <summary>Contains spoilers · reveal this take</summary>
                          <p className="cove-arena-body">{post.body}</p>
                        </details>
                      ) : (
                        <p className="cove-arena-body">{post.body}</p>
                      )}
                      <div className="cove-arena-card-bottom">
                        <div
                          className="cove-arena-votes"
                          role="group"
                          aria-label="React to this take"
                        >
                          <button
                            type="button"
                            aria-pressed={chosenFire}
                            className={chosenFire ? "selected fire" : "fire"}
                            disabled={!!busy}
                            onClick={() => vote(post, "agree")}
                          >
                            🔥 <b>{post.fire}</b> <span>Fire</span>
                          </button>
                          <button
                            type="button"
                            aria-pressed={chosenClown}
                            className={chosenClown ? "selected clown" : "clown"}
                            disabled={!!busy}
                            onClick={() => vote(post, "funny")}
                          >
                            🤡 <b>{post.clown}</b> <span>Clown</span>
                          </button>
                          <a
                            href={
                              "/community?arenaPost=" +
                              encodeURIComponent(post.id) +
                              "&arenaOwner=" +
                              encodeURIComponent(post.user?.id || "")
                            }
                            className="cove-arena-replies"
                          >
                            <MessageCircle size={16} /> {post.replies} replies
                          </a>
                        </div>
                        <div className="cove-arena-card-actions">
                          {post.bookId && (
                            <a
                              className="cove-arena-book-link"
                              href={"/books/" + encodeURIComponent(post.bookId)}
                            >
                              <BookOpen size={14} /> Book
                            </a>
                          )}
                          {data.user?.id === post.user?.id ? (
                            <button
                              className="cove-arena-text-button"
                              type="button"
                              disabled={!!busy}
                              onClick={() => remove(post)}
                            >
                              Delete
                            </button>
                          ) : data.user ? (
                            <button
                              className="cove-arena-text-button"
                              type="button"
                              onClick={() => setReporting(reporting === post.id ? "" : post.id)}
                            >
                              Report
                            </button>
                          ) : null}
                        </div>
                      </div>
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
                    </div>
                    {post.bookId && VERIFIED_COVER_IDS.has(post.bookId) && (
                      <a
                        className="cove-arena-card-book-image"
                        href={"/books/" + encodeURIComponent(post.bookId)}
                        aria-label="View related book"
                      >
                        <img
                          src={"/covers/" + post.bookId + ".jpg"}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.hidden = true;
                          }}
                        />
                      </a>
                    )}
                  </article>
                );
              })}
            </div>
            {!feed.isLoading && !feed.isError && !items.length && (
              <div className="cove-arena-status">
                {searchTerm
                  ? "No matching public debates in this page of recent activity. "
                  : debateFilter === "following" && fullPage
                    ? "No debates from readers you follow in this page. "
                    : "No public posts in this feed yet. Got an opinion? "}{" "}
                <button type="button" className="text-link" onClick={() => openComposer("take")}>
                  Start the conversation.
                </button>
              </div>
            )}
            {feed.hasNextPage && (
              <button
                className="cove-arena-load"
                type="button"
                disabled={feed.isFetchingNextPage}
                onClick={() => feed.fetchNextPage()}
              >
                {feed.isFetchingNextPage ? "Loading…" : "More hot takes"} <ChevronRight size={16} />
              </button>
            )}
          </section>
        </div>
        <aside className="cove-arena-rail" aria-label="Community matchups and posting">
          <OfficialTournament />
          <section className="cove-arena-tournament" aria-labelledby="cove-tournament-heading">
            <div className="cove-arena-rail-head">
              <h2 id="cove-tournament-heading">
                <Trophy size={18} /> TOURNAMENTS
              </h2>
              <button type="button" onClick={() => setBracketOpen(true)}>
                VIEW MATCHUPS <ArrowRight size={15} />
              </button>
            </div>
            {bracket.isLoading && (
              <p className="cove-arena-rail-state" role="status">
                Checking active matchups…
              </p>
            )}
            {bracket.isError && (
              <p className="cove-arena-rail-state" role="alert">
                Bracket unavailable. <button onClick={() => bracket.refetch()}>Retry</button>
              </p>
            )}
            {headlineMatch && matchNames ? (
              <>
                <div className="cove-arena-match-heading">
                  <span>READER'S CHOICE</span>
                  <h3>Which book wins?</h3>
                  <p>Open matchup · Vote for your favorite</p>
                </div>
                <div className="cove-arena-contenders">
                  {matchNames.map((name, index) => (
                    <div className="cove-arena-contender" key={index}>
                      <ReaderCover title={name} />
                      <strong>{name}</strong>
                      <button
                        type="button"
                        disabled={!!busy}
                        aria-pressed={(headlineMatch.myReactions || []).includes(
                          index === 0 ? "agree" : "funny",
                        )}
                        onClick={() => vote(headlineMatch, index === 0 ? "agree" : "funny")}
                      >
                        Vote {index === 0 ? "A" : "B"}
                      </button>
                    </div>
                  ))}
                  <span className="cove-arena-versus" aria-hidden="true">
                    VS
                  </span>
                </div>
                <div className="cove-arena-tournament-score" aria-label="Matchup votes">
                  {totalVotes > 0 ? (
                    <>
                      <div className="cove-arena-score-numbers">
                        <strong>{aPercent}%</strong>
                        <span>
                          {totalVotes} vote{totalVotes === 1 ? "" : "s"}
                        </span>
                        <strong>{bPercent}%</strong>
                      </div>
                      <div className="cove-arena-score-track">
                        <span style={{ width: aPercent + "%" }} />
                        <span style={{ width: bPercent + "%" }} />
                      </div>
                    </>
                  ) : (
                    <p>Be the first reader to cast a vote.</p>
                  )}
                </div>
                <a
                  className="cove-arena-match-discuss"
                  href={
                    "/community?arenaPost=" +
                    encodeURIComponent(headlineMatch.id) +
                    "&arenaOwner=" +
                    encodeURIComponent(headlineMatch.user?.id || "")
                  }
                >
                  <MessageCircle size={15} /> Discuss this matchup <ArrowRight size={14} />
                </a>
              </>
            ) : (
              !bracket.isLoading &&
              !bracket.isError && (
                <div className="cove-arena-rail-state">
                  <BookOpen size={30} />
                  <p>No public matchups yet. Start a two-book showdown.</p>
                  <button
                    type="button"
                    className="cove-arena-rail-cta"
                    onClick={() =>
                      openComposer("matchup", "A: \nB: \n\nWhich book should win, and why?")
                    }
                  >
                    Create a matchup
                  </button>
                </div>
              )
            )}
            <div className="cove-arena-activity">
              <div className="cove-arena-activity-heading">
                <h3>
                  <Flame size={15} /> BRACKET ACTIVITY
                </h3>
                <small>Refreshes every 30s</small>
              </div>
              {(bracket.data?.activity || []).length > 0 && (
                <ul aria-label="Recent recorded matchup votes">
                  {(bracket.data?.activity || []).slice(0, 6).map((event, index) => {
                    const post = matchups.find((item) => item.id === event.postId);
                    const book = post
                      ? matchupNames(post.body)[event.side === "A" ? 0 : 1]
                      : "a contender";
                    return (
                      <li key={event.postId + ":" + index}>
                        <span className="cove-arena-activity-dot" />
                        <span>
                          A reader voted for <b>{book}</b>
                          <small>
                            {post ? matchupNames(post.body).join(" vs ") : "Matchup"} ·{" "}
                            {timeAgo(event.createdAt)}
                          </small>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {matchups.length ? (
                <ul>
                  {matchups.slice(0, 3).map((post) => (
                    <li key={post.id}>
                      <span className="cove-arena-activity-dot" />
                      <span>
                        <b>{post.user?.name || "A reader"}</b> opened{" "}
                        <a
                          href={
                            "/community?arenaPost=" +
                            encodeURIComponent(post.id) +
                            "&arenaOwner=" +
                            encodeURIComponent(post.user?.id || "")
                          }
                        >
                          {matchupNames(post.body).join(" vs ")}
                        </a>
                        <small>
                          {post.fire + post.clown} recorded votes · {timeAgo(post.createdAt)}
                        </small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cove-arena-activity-empty">New public matchups will appear here.</p>
              )}
            </div>
          </section>
          <section className="cove-arena-composer" id="cove-arena-compose">
            <div className="cove-arena-rail-head">
              <h2>
                <Plus size={18} /> HAVE A TAKE?
              </h2>
            </div>
            <p className="cove-arena-compose-intro">
              The next great reading debate starts with a reader.
            </p>
            {!data.user ? (
              <button type="button" className="cove-arena-rail-cta" onClick={signIn}>
                Sign in to post
              </button>
            ) : mine.isLoading ? (
              <p className="cove-arena-rail-state">Checking Community privacy settings…</p>
            ) : !publicProfile ? (
              <div className="cove-arena-private-note">
                <ShieldAlert size={18} />
                <p>
                  Public posts require a public reader profile and public activity visibility.
                  <a href="/settings"> Adjust privacy settings</a>. Your private library,
                  highlights, and reading position stay private.
                </p>
              </div>
            ) : !composerOpen ? (
              <button type="button" className="cove-arena-rail-cta" onClick={() => openComposer()}>
                <Plus size={16} /> Start a conversation
              </button>
            ) : (
              <div className="cove-arena-compose-form">
                <div className="cove-arena-kind" role="group" aria-label="Post format">
                  {(
                    [
                      ["take", "Hot Take"],
                      ["debate", "Debate"],
                      ["matchup", "Matchup"],
                    ] as const
                  ).map(([value, title]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={kind === value}
                      className={kind === value ? "selected" : ""}
                      onClick={() => setKind(value)}
                    >
                      {title}
                    </button>
                  ))}
                </div>
                <label htmlFor="arena-body">
                  {kind === "matchup" ? "Two contenders (A: / B:)" : "Your take"}
                </label>
                <textarea
                  id="arena-body"
                  className="note-input"
                  value={body}
                  maxLength={11000}
                  placeholder={
                    kind === "matchup"
                      ? "A: Book one\nB: Book two\n\nMake your case…"
                      : "What is your most defensible book opinion?"
                  }
                  onChange={(e) => setBody(e.target.value)}
                />
                <label htmlFor="arena-book">Related Cove book (optional)</label>
                <input
                  id="arena-book"
                  className="note-input"
                  value={bookRef}
                  maxLength={240}
                  placeholder="Book ID or /books/… link"
                  onChange={(e) => setBookRef(e.target.value)}
                />
                <label className="cove-arena-spoiler">
                  <input
                    type="checkbox"
                    checked={spoiler}
                    onChange={(e) => setSpoiler(e.target.checked)}
                  />{" "}
                  Contains spoilers
                </label>
                <div className="cove-arena-publish-actions">
                  <button
                    type="button"
                    className="cove-arena-rail-cta"
                    disabled={!!busy || body.trim().length < 10}
                    onClick={publish}
                  >
                    {busy === "publish" ? "Publishing…" : "Publish take"}
                  </button>
                  <button
                    type="button"
                    className="cove-arena-text-button"
                    disabled={!!busy}
                    onClick={() => setComposerOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <p className="cove-arena-compose-rule">
              Keep it about books. Mark spoilers. Challenge ideas, not people.
            </p>
          </section>
        </aside>
      </div>
      <Dialog open={bracketOpen} onOpenChange={setBracketOpen}>
        <DialogContent className="cove-arena-bracket-dialog">
          <DialogTitle>
            <Trophy size={20} /> Reader-created standalone matchups
          </DialogTitle>
          <DialogDescription>
            Each head-to-head reflects a public matchup and its real votes. Winners and later rounds
            are not declared automatically.
          </DialogDescription>
          {matchups.length ? (
            <div className="cove-arena-bracket-board">
              {matchups.map((post) => {
                const names = matchupNames(post.body);
                const total = post.fire + post.clown;
                return (
                  <div className="cove-arena-bracket-entry" key={post.id}>
                    <div className="cove-arena-bracket-pair">
                      {names.map((name, index) => (
                        <button
                          type="button"
                          key={index}
                          disabled={!!busy}
                          aria-pressed={(post.myReactions || []).includes(
                            index === 0 ? "agree" : "funny",
                          )}
                          onClick={() => vote(post, index === 0 ? "agree" : "funny")}
                        >
                          <ReaderCover title={name} className="cove-arena-bracket-cover" />
                          <span>{name}</span>
                          <b>{index === 0 ? post.fire : post.clown}</b>
                        </button>
                      ))}
                    </div>
                    <div className="cove-arena-bracket-connector" aria-hidden="true" />
                    <div className="cove-arena-bracket-next">
                      <strong>Winner TBD</strong>
                      <small>{total ? total + " votes so far" : "Awaiting votes"}</small>
                    </div>
                    <a
                      href={
                        "/community?arenaPost=" +
                        encodeURIComponent(post.id) +
                        "&arenaOwner=" +
                        encodeURIComponent(post.user?.id || "")
                      }
                    >
                      See matchup discussion <ArrowRight size={14} />
                    </a>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="cove-arena-rail-state">No public matchups to show yet.</p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
