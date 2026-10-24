import { useUiText } from "./ui-text";
import "./reading-community.css";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import {
  Activity,
  BookHeart,
  BookOpen,
  Check,
  ChevronRight,
  CircleUserRound,
  Club,
  Heart,
  ListPlus,
  LockKeyhole,
  MessageCircle,
  Plus,
  Share2,
  Sparkles,
  Star,
  UserPlus,
  Users,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";
import { api, authorOf, useAccount, type CatalogBook } from "./client";
import { SharingPage, MemberPicker, type ShareMember } from "./Sharing";
import { useStorefrontLocale } from "./localization";

type Post = {
  id: string;
  locked?: boolean;
  user?: { id: string; username: string; name: string };
  postType?: string;
  body?: string;
  passageText?: string;
  chapter?: string;
  progress?: number;
  visibility?: string;
  spoiler?: boolean;
  replies?: number;
  reactions?: number;
  myReactions?: string[];
  version?: number;
  createdAt?: string;
  editedAt?: string | null;
  replyItems?: Post[];
};
const when = (value?: string) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(value))
    : "";
const duration = (seconds = 0) => {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const bookHref = (b: any) => `/books/${encodeURIComponent(String(b?.productId || b?.id || ""))}`;

export function DiscussionThread({
  contextType,
  contextId,
  progress = 1,
  title = "Discussion & questions",
  groupId,
  onChanged,
  postId,
  parentId,
  initialPost,
  initialUpdatedAt,
  bookThread = false,
  depth = 0,
}: {
  contextType: "work" | "margin" | "group" | "list" | "profile";
  contextId: string;
  progress?: number;
  title?: string;
  groupId?: string;
  onChanged?: () => void;
  postId?: string;
  parentId?: string;
  initialPost?: Post;
  initialUpdatedAt?: number;
  bookThread?: boolean;
  depth?: number;
}) {
  const ui = useUiText();
  const { data, signIn } = useAccount();
  const [body, setBody] = useState("");
  const [threadSort, setThreadSort] = useState<"top" | "new">("top");
  const [kind, setKind] = useState<"discussion" | "question">("discussion");
  const [spoiler, setSpoiler] = useState(false);
  const [replying, setReplying] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Post | null>(null);
  const [reporting, setReporting] = useState<Post | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const q = useInfiniteQuery<{ posts: Post[]; nextCursor: string | null }>({
    queryKey: ["social-posts", data.user?.id, contextType, contextId, postId, parentId, bookThread, threadSort],
    initialPageParam: "",
    initialData: initialPost
      ? { pages: [{ posts: [initialPost], nextCursor: null }], pageParams: [""] }
      : undefined,
    initialDataUpdatedAt: initialPost ? initialUpdatedAt : undefined,
    staleTime: 30_000,
    queryFn: ({ pageParam }) =>
      api(
        `/social/posts?contextType=${contextType}&contextId=${encodeURIComponent(contextId)}&includeReplies=false${bookThread ? `&thread=1&sort=${threadSort}` : ""}${postId ? `&postId=${encodeURIComponent(postId)}` : ""}${parentId ? `&parentId=${encodeURIComponent(parentId)}` : ""}${pageParam ? `&cursor=${encodeURIComponent(String(pageParam))}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
  });
  const posts = [
    ...new Map((q.data?.pages.flatMap((page) => page.posts) || []).map((p) => [p.id, p])).values(),
  ];
  async function saveEdit(p: Post) {
    if (busy || !editBody.trim()) return;
    setBusy(true);
    try {
      await api(`/social/posts/${encodeURIComponent(p.id)}`, "PATCH", {
        body: editBody,
        expectedVersion: p.version || 1,
      });
      setEditing(null);
      await q.refetch();
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    const targetParent = parentId;
    if (busy) return;
    if (!data.user) return signIn();
    const text = body;
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api("/social/posts", "POST", {
        contextType,
        contextId,
        parentId: targetParent || null,
        postType: targetParent ? "reply" : kind,
        body: text,
        visibility: contextType === "group" ? "group" : "public",
        spoiler: parentId ? false : spoiler,
        progress: !parentId && contextType === "group" && spoiler ? progress : undefined,
      });
      setBody("");
      setReplying(null);
      setSpoiler(false);
      await q.refetch();
      onChanged?.();
      toast.success(targetParent ? ui("Reply posted") : ui("Posted to the discussion"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function react(p: Post) {
    if (!data.user) return signIn();
    if (busy) return;
    setBusy(true);
    try {
      const active = !(p.myReactions || []).includes("heart");
      await api(`/social/posts/${encodeURIComponent(p.id)}/reaction`, "POST", {
        reaction: "heart",
        active,
      });
      await q.refetch();
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(p: Post) {
    if (!data.user || busy) return;
    setBusy(true);
    try {
      await api(`/social/posts/${encodeURIComponent(p.id)}`, "DELETE", {
        expectedVersion: p.version || 1,
      });
      await q.refetch();
      onChanged?.();
      setRemoving(null);
      toast.success(ui("Discussion removed"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function report() {
    if (!data.user) return signIn();
    if (busy || !reporting || !reportReason || (reportReason === "other" && !reportDetails.trim()))
      return;
    setBusy(true);
    try {
      await api("/social/report", "POST", {
        subjectType: "social_post",
        subjectId: reporting.id,
        reason: reportReason,
        details: reportDetails.trim(),
      });
      setReporting(null);
      setReportReason("");
      setReportDetails("");
      toast.success(ui("Report sent to moderation"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const postBody = (p: Post) => (
    <>
      {p.passageText && <blockquote>“{p.passageText}”</blockquote>}
      {p.spoiler ? (
        <details className="spoiler-disclosure">
          <summary>{ui("Spoiler — reveal")}</summary>
          <p>{p.body}</p>
        </details>
      ) : (
        <p>{p.body}</p>
      )}
    </>
  );
  return (
    <section
      className="social-thread"
      aria-labelledby={`${contextType}-${contextId}-${postId || parentId || "root"}-discussion`}
    >
      <div className="section-heading">
        <div>
          <span className="small-label">{ui("CONVERSATION")}</span>
          <h2 id={`${contextType}-${contextId}-${postId || parentId || "root"}-discussion`}>
            {title}
          </h2>
        </div>
      </div>
      {bookThread && !postId && (
        <div className="cove-thread-sort" role="group" aria-label="Order book discussions">
          <button type="button" aria-pressed={threadSort === "top"} onClick={() => setThreadSort("top")}>
            Top hearts
          </button>
          <button type="button" aria-pressed={threadSort === "new"} onClick={() => setThreadSort("new")}>
            Newest
          </button>
          <span>Only a few replies load at a time. Hearts represent unique reader reactions.</span>
        </div>
      )}
      {!postId && (contextType !== "margin" || !!parentId) && (
        <div className="social-composer">
          {!parentId && (
            <div className="social-composer-tabs">
              <button
                className={kind === "discussion" ? "selected" : ""}
                onClick={() => setKind("discussion")}
              >
                {ui("Discussion")}
              </button>
              <button
                className={kind === "question" ? "selected" : ""}
                onClick={() => setKind("question")}
              >
                {ui("Question")}
              </button>
            </div>
          )}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label={parentId ? "Write a reply" : "Start a conversation"}
            placeholder={
              data.user
                ? parentId
                  ? "Write a reply…"
                  : "Start a conversation…"
                : ui("Sign in to join the conversation")
            }
            maxLength={12000}
          />
          {!parentId && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={spoiler}
                onChange={(e) => setSpoiler(e.target.checked)}
              />{" "}
              {contextType === "group"
                ? ui("Spoiler — hide from members who have not reached my current progress")
                : ui("Hide this post behind a spoiler warning")}
            </label>
          )}
          {parentId && (
            <p className="small muted">
              {ui("Your reply uses the original discussion’s audience and spoiler settings.")}
            </p>
          )}
          <button className="button gold" disabled={busy || !body.trim()} onClick={() => publish()}>
            <MessageCircle size={16} /> {parentId ? "Reply" : "Post"}
          </button>
        </div>
      )}
      <div className="social-post-list">
        {q.isLoading ? (
          <p className="muted">{ui("Loading discussion…")}</p>
        ) : posts.length ? (
          posts.map((p) =>
            p.locked ? (
              <article className="social-post locked" key={p.id}>
                <LockKeyhole size={16} />
                <p>{ui("Discussion unlocks when you reach this part of the book.")}</p>
              </article>
            ) : (
              <article className="social-post" key={p.id} data-post-id={p.id}>
                <header>
                  <a
                    href={`/community?profile=${encodeURIComponent(p.user?.username || p.user?.id || "")}`}
                  >
                    <strong>{p.user?.name || "Reader"}</strong>
                    <span>@{p.user?.username || "reader"}</span>
                  </a>
                  <span>
                    {p.postType === "question" ? ui("Question") : ui("Discussion")}
                    {p.chapter ? ` · ${p.chapter}` : ""}
                    {p.editedAt ? " · edited" : ""}
                  </span>
                </header>
                {editing === p.id ? (
                  <div>
                    <label>
                      {ui("Edit published discussion")}
                      <textarea
                        aria-label={ui("Edit discussion")}
                        maxLength={12000}
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                      />
                    </label>
                    <button disabled={busy || !editBody.trim()} onClick={() => saveEdit(p)}>
                      {ui("Save published edit")}
                    </button>
                    <button onClick={() => setEditing(null)}>{ui("Cancel")}</button>
                  </div>
                ) : (
                  postBody(p)
                )}
                <footer>
                  <button
                    className={(p.myReactions || []).includes("heart") ? "selected" : ""}
                    aria-pressed={(p.myReactions || []).includes("heart")}
                    aria-label={`React with a heart (${p.reactions || 0})`}
                    disabled={busy}
                    onClick={() => react(p)}
                  >
                    <Heart size={14} /> {p.reactions || 0}
                  </button>
                  <button
                    aria-label={`Show replies (${p.replies || 0})`}
                    onClick={() => setReplying(replying === p.id ? null : p.id)}
                    aria-expanded={replying === p.id && (!bookThread || depth < 2)}
                  >
                    <MessageCircle size={14} /> {p.replies || 0}
                  </button>
                  {data.user?.id === p.user?.id ? (
                    <>
                      <button
                        onClick={() => {
                          setEditing(p.id);
                          setEditBody(p.body || "");
                        }}
                      >
                        {ui("Edit")}
                      </button>
                      <button disabled={busy} onClick={() => setRemoving(p)}>
                        {ui("Delete")}
                      </button>
                    </>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (!data.user) return signIn();
                        setReportReason("");
                        setReportDetails("");
                        setReporting(p);
                      }}
                    >
                      {ui("Report")}
                    </button>
                  )}
                  <span>{when(p.createdAt)}</span>
                </footer>
                {bookThread && depth >= 2 ? (
                  <a
                    className="cove-thread-focus-link"
                    href={`/community?thread=${encodeURIComponent(p.id)}&work=${encodeURIComponent(contextId)}`}
                  >
                    Continue this conversation on its own page · {p.replies || 0} replies
                  </a>
                ) : (
                  replying === p.id && (
                    <div className={bookThread ? "cove-thread-children" : undefined}>
                      <DiscussionThread
                        contextType={contextType}
                        contextId={contextId}
                        parentId={p.id}
                        progress={progress}
                        bookThread={bookThread}
                        depth={depth + 1}
                        title={ui("Replies")}
                        onChanged={() => {
                          void q.refetch();
                          onChanged?.();
                        }}
                      />
                    </div>
                  )
                )}
              </article>
            ),
          )
        ) : (
          <p className="muted">{ui("No discussion yet. You can start the first one.")}</p>
        )}
        {q.isError && (
          <p role="alert">
            {ui("Could not load discussion.")}{" "}
            <button onClick={() => q.refetch()}>{ui("Retry")}</button>
          </p>
        )}
        {q.hasNextPage && (
          <button disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            {ui("Load older discussion")}
          </button>
        )}
      </div>
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <AlertDialogContent className="fore-dialog">
          <AlertDialogTitle>{ui("Delete this discussion?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {ui(
              "This removes the published discussion and access to its replies. Your private highlights and notes are unchanged.",
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{ui("Keep discussion")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (removing) void remove(removing);
              }}
            >
              {busy ? "Deleting…" : ui("Delete published discussion")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={!!reporting}
        onOpenChange={(open) => {
          if (!open && !busy) setReporting(null);
        }}
      >
        <DialogContent className="fore-dialog">
          <DialogTitle>{ui("Report this discussion")}</DialogTitle>
          <DialogDescription>
            {ui(
              "Choose the reason so moderators can review it. Reporting does not publish your explanation to other readers.",
            )}
          </DialogDescription>
          <label>
            {ui("Report reason")}
            <select
              value={reportReason}
              onChange={(event) => setReportReason(event.target.value)}
              disabled={busy}
            >
              <option value="">{ui("Choose a reason")}</option>
              <option value="spam">{ui("Spam")}</option>
              <option value="scam">{ui("Scam")}</option>
              <option value="impersonation">{ui("Impersonation")}</option>
              <option value="harassment">{ui("Harassment")}</option>
              <option value="misleading">{ui("Misleading content")}</option>
              <option value="copyright">{ui("Copyright")}</option>
              <option value="other">{ui("Other")}</option>
            </select>
          </label>
          <label>
            {ui("Report details")}
            <textarea
              className="note-input"
              value={reportDetails}
              onChange={(event) => setReportDetails(event.target.value)}
              maxLength={5000}
              disabled={busy}
            />
          </label>
          <button
            className="button gold"
            disabled={busy || !reportReason || (reportReason === "other" && !reportDetails.trim())}
            onClick={() => report()}
          >
            {busy ? "Submitting…" : ui("Submit report")}
          </button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
function Feed() {
  const ui = useUiText();
  const { data } = useAccount();
  const q = useInfiniteQuery({
    queryKey: ["social-feed", data.user?.id],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<any>(
        `/social/feed?limit=40${pageParam ? `&cursor=${encodeURIComponent(String(pageParam))}` : ""}`,
      ),
    getNextPageParam: (page: any) => page.nextCursor || undefined,
    enabled: !!data.user,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const loadingMore = q.isFetchingNextPage;
  const next = q.hasNextPage;
  const items = q.data?.pages.flatMap((page) => page.items || []) || [];
  async function loadMore() {
    if (!next || loadingMore) return;
    try {
      await q.fetchNextPage();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <section>
      <div className="social-page-heading">
        <div>
          <span className="small-label">{ui("YOUR READING CIRCLE")}</span>
          <h1>{ui("Activity")}</h1>
          <p>{ui("Books being finished, loved, discussed, and shared by readers you follow.")}</p>
        </div>
      </div>
      <div className="social-feed">
        {items.length ? (
          items.map((e: any) => (
            <article className="social-feed-card" key={e.id}>
              <a
                className="social-feed-person"
                href={`/community?profile=${encodeURIComponent(e.user?.username || e.user?.id)}`}
              >
                <span className="social-avatar">{String(e.user?.name || "R").slice(0, 1)}</span>
                <span>
                  <strong>{e.user?.name || "Reader"}</strong>
                  <small>
                    @{e.user?.username || "reader"} · {when(e.created_at)}
                  </small>
                </span>
              </a>
              <p>{eventSentence(e)}</p>
              {e.book && (
                <a className="feed-book" href={bookHref(e.book)}>
                  <BookOpen size={18} />
                  <span>
                    <strong>{e.book.title}</strong>
                    <small>{e.book.authors}</small>
                  </span>
                </a>
              )}
              {e.event_type === "journey_finished" && e.payload?.journeyId && (
                <a
                  className="text-link"
                  href={`/community?journey=${encodeURIComponent(e.payload.journeyId)}`}
                >
                  {ui("View Reading Journey")} <ChevronRight size={14} />
                </a>
              )}
            </article>
          ))
        ) : (
          <p className="muted">{ui("Follow readers to build your activity feed.")}</p>
        )}
        {next && (
          <button
            className="button outline social-feed-more"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore ? "Loading…" : ui("Load older activity")}
          </button>
        )}
      </div>
    </section>
  );
}
function eventSentence(e: any) {
  if (e.event_type === "journey_finished")
    return `Finished ${e.payload?.title || e.book?.title || "a book"}.`;
  if (e.event_type === "review_published") return `Reviewed ${e.book?.title || "a book"}.`;
  if (e.event_type === "shared_highlight")
    return `Shared a highlight${e.payload?.chapter ? ` from ${e.payload.chapter}` : ""}.`;
  if (e.event_type === "list_created")
    return `Created the list “${e.payload?.title || "Reading list"}”.`;
  if (e.event_type === "club_started")
    return `Started the reading group “${e.payload?.name || "Book club"}”.`;
  if (e.event_type === "top_books_changed") return `Updated The Three.`;
  if (e.event_type === "followed_user") return `Started following another reader.`;
  return "Shared reading activity.";
}

function Discover() {
  const ui = useUiText();
  const { data: account, loading: accountLoading } = useAccount();
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const people = useInfiniteQuery<any>({
    queryKey: ["member-search", account.user?.id, term],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api(
        `/social/discover?q=${encodeURIComponent(term)}&after=${encodeURIComponent(String(pageParam))}`,
      ),
    getNextPageParam: (page) => page.nextPeopleCursor || undefined,
  });
  const q = useQuery<any>({
    queryKey: ["social-discover", account.user?.id],
    queryFn: () => api("/social/discover"),
  });
  return (
    <section>
      <div className="social-page-heading">
        <div>
          <span className="small-label">{ui("DISCOVER")}</span>
          <h1>{ui("Readers, lists & clubs")}</h1>
          <p>
            {ui(
              "Find people whose taste you trust, then read alongside them without turning the book into a feed.",
            )}
          </p>
        </div>
      </div>
      <h2>{ui("Readers")}</h2>
      <label>
        {ui("Find a member")}
        <input
          type="search"
          disabled={!interactive || accountLoading}
          maxLength={100}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={ui("Name or @username")}
        />
      </label>
      {people.isError && (
        <p role="alert">
          {ui("Search failed.")} <button onClick={() => people.refetch()}>{ui("Retry")}</button>
        </p>
      )}
      <div className="people-grid">
        {people.data?.pages
          .flatMap((page) => page.people)
          .map((p: any) => (
            <a
              className="person-card"
              href={`/community?profile=${encodeURIComponent(p.username || p.user_id)}`}
              key={p.user_id}
            >
              <span className="social-avatar large">
                {String(p.name || p.username || "R").slice(0, 1)}
              </span>
              <strong>{p.name || p.username}</strong>
              <span>@{p.username}</span>
              <p>{p.bio || ui("Reader on Cove")}</p>
              <small>
                {Number(p.followers || 0).toLocaleString()} {ui("followers")}
              </small>
            </a>
          ))}
      </div>
      {people.hasNextPage && (
        <button disabled={people.isFetchingNextPage} onClick={() => people.fetchNextPage()}>
          {ui("More members")}
        </button>
      )}
      {!people.isLoading && !people.data?.pages.some((page) => page.people.length) && (
        <p>{ui("No members found.")}</p>
      )}
      <h2>{ui("Reading lists")}</h2>
      <div className="social-card-grid">
        {q.data?.lists?.map((l: any) => (
          <a className="social-list-card" href={`/community?list=${l.id}`} key={l.id}>
            <ListPlus />
            <strong>{l.title}</strong>
            <p>{l.description}</p>
            <small>
              {l.item_count} {ui("books ·")} {l.likes} {ui("likes")}
            </small>
          </a>
        ))}
      </div>
      <h2>{ui("Reading groups")}</h2>
      <div className="social-card-grid">
        {q.data?.groups?.map((g: any) => (
          <a className="social-list-card" href={`/community?club=${g.id}`} key={g.id}>
            <Users />
            <strong>{g.name}</strong>
            <p>{g.description}</p>
            <small>
              {g.member_count} {ui("members ·")} {g.group_type.replaceAll("_", " ")}
            </small>
          </a>
        ))}
      </div>
    </section>
  );
}

function PublicProfile({ ref }: { ref: string }) {
  const ui = useUiText();
  const { data, signIn } = useAccount();
  const q = useQuery<any>({
    queryKey: ["social-profile", ref],
    queryFn: () => api(`/social/profile/${encodeURIComponent(ref)}`),
  });
  async function follow() {
    if (!data.user) return signIn();
    try {
      const rel = q.data.relationship,
        following = !!rel.following || rel.followRequestStatus === "pending";
      await api("/social/follow", "POST", { userId: q.data.profile.id, following: !following });
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function mute() {
    if (!data.user) return signIn();
    try {
      await api("/social/mute", "POST", {
        userId: q.data.profile.id,
        muted: !q.data.relationship.muted,
      });
      await q.refetch();
      toast.success(q.data.relationship.muted ? ui("Reader unmuted") : ui("Reader muted"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function block() {
    if (!data.user) return signIn();
    if (
      !confirm(
        `Block ${q.data.profile.name}? You will no longer see each other's Community activity.`,
      )
    )
      return;
    try {
      await api("/social/block", "POST", { userId: q.data.profile.id, blocked: true });
      toast.success(ui("Reader blocked"));
      location.assign("/community?tab=me");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function report() {
    if (!data.user) return signIn();
    try {
      await api("/social/report", "POST", {
        subjectType: "social_profile",
        subjectId: q.data.profile.id,
        reason: "other",
        details: "Reported from the reader profile interface for moderator review.",
      });
      toast.success(ui("Profile report sent to moderation"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  if (q.isLoading) return <p className="muted">{ui("Loading reader…")}</p>;
  if (!q.data) return <p className="notice">{ui("Reader not found.")}</p>;
  const x = q.data,
    followLabel = x.relationship.following
      ? "Following"
      : x.relationship.followRequestStatus === "pending"
        ? "Requested"
        : "Follow";
  return (
    <section className="public-reader-profile">
      <header className="reader-profile-hero">
        <span className="social-avatar xlarge">{String(x.profile.name || "R").slice(0, 1)}</span>
        <div>
          <span className="small-label">{ui("READER PROFILE")}</span>
          <h1>{x.profile.name}</h1>
          <p>@{x.profile.username}</p>
          <p>{x.profile.bio}</p>
          <div className="profile-stat-row">
            <span>
              <strong>{x.counts.followers}</strong> {ui("followers")}
            </span>
            <span>
              <strong>{x.counts.following}</strong> {ui("following")}
            </span>
            <span>
              <strong>{x.counts.finished}</strong> {ui("finished")}
            </span>
          </div>
        </div>
        {data.user?.id !== x.profile.id && (
          <div className="profile-actions">
            <button
              className={`button ${x.relationship.following ? "outline" : "gold"}`}
              onClick={follow}
            >
              <UserPlus size={16} />
              {followLabel}
            </button>
            <button className="button outline" onClick={mute}>
              {x.relationship.muted ? "Unmute" : "Mute"}
            </button>
            <button className="button outline" onClick={block}>
              {ui("Block")}
            </button>
            <button className="text-link" onClick={report}>
              {ui("Report")}
            </button>
          </div>
        )}
      </header>
      <section>
        <span className="small-label">{ui("THE THREE")}</span>
        <h2>{ui("Three books that say the most")}</h2>
        <div className="three-grid">
          {x.topBooks.map((b: any) => (
            <a href={bookHref(b.book)} key={b.position}>
              <span>{b.position}</span>
              <strong>{b.book?.title}</strong>
              <small>{b.book?.authors}</small>
            </a>
          ))}
        </div>
      </section>
      {x.currentlyReading && (
        <section className="currently-reading-card">
          <span className="small-label">{ui("CURRENTLY READING")}</span>
          <a href={bookHref(x.currentlyReading.book)}>
            <strong>{x.currentlyReading.book?.title}</strong>
            <span>{Math.round(x.currentlyReading.progress * 100)}%</span>
          </a>
          <div className="progress-track">
            <i style={{ width: `${Math.round(x.currentlyReading.progress * 100)}%` }} />
          </div>
        </section>
      )}
      <section>
        <h2>{ui("Reading Journeys")}</h2>
        <div className="journey-mini-grid">
          {x.journeys.map((j: any) => (
            <a href={`/community?journey=${j.id}`} key={j.id}>
              <strong>{j.title_snapshot}</strong>
              <span>
                {j.elapsed_days} {ui("days ·")} {j.session_count} {ui("sessions")}
              </span>
            </a>
          ))}
        </div>
      </section>
      <section>
        <h2>{ui("Lists")}</h2>
        <div className="social-card-grid">
          {x.lists.map((l: any) => (
            <a className="social-list-card" href={`/community?list=${l.id}`} key={l.id}>
              <strong>{l.title}</strong>
              <p>{l.description}</p>
              <small>
                {l.item_count} {ui("books ·")} {l.likes} {ui("likes")}
              </small>
            </a>
          ))}
        </div>
      </section>
      <DiscussionThread
        contextType="profile"
        contextId={x.profile.id}
        title={`Replies to ${x.profile.name}`}
      />
    </section>
  );
}
function Journey({ id }: { id: string }) {
  const ui = useUiText();
  const q = useQuery<any>({
    queryKey: ["journey", id],
    queryFn: () => api(`/social/journeys/${encodeURIComponent(id)}`),
  });
  const [member, setMember] = useState<ShareMember | null>(null);
  const [memberConfirmed, setMemberConfirmed] = useState(false);
  const [linkConfirmed, setLinkConfirmed] = useState(false);
  const grants = useQuery<{
    recipients: {
      recipient_user_id: string;
      share_token: string;
      version: number;
      revoked_at: string | null;
      member: ShareMember | null;
    }[];
  }>({
    queryKey: ["journey-recipients", id],
    queryFn: () => api(`/social/journeys/${encodeURIComponent(q.data.id)}/recipients`),
    enabled: !!q.data?.mine,
  });
  async function copyMemberLink(token: string) {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/community?journey=${encodeURIComponent(token)}`,
      );
      toast.success(ui("Member-only link copied"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function grantMember() {
    if (!member || !memberConfirmed || busy) return;
    setBusy(true);
    try {
      const existing = grants.data?.recipients.find((g) => g.recipient_user_id === member.id);
      await api(`/social/journeys/${encodeURIComponent(q.data.id)}/recipients`, "POST", {
        recipientUserId: member.id,
        expectedVersion: existing?.version || 0,
        audienceConfirmed: true,
      });
      setMember(null);
      setMemberConfirmed(false);
      await grants.refetch();
      toast.success(ui("Member access granted"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revokeMember(recipientUserId: string, version: number) {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/social/journeys/${encodeURIComponent(q.data.id)}/recipients`, "DELETE", {
        recipientUserId,
        expectedVersion: version,
      });
      await grants.refetch();
      toast.success(ui("Member access revoked"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const [format, setFormat] = useState<"square" | "story">("square");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  useEffect(() => {
    if (q.data)
      setDraft({
        visibility: q.data.visibility,
        theme: q.data.theme,
        showRating: !!q.data.show_rating,
        showTime: !!q.data.show_time,
        showDates: !!q.data.show_dates,
        showPace: !!q.data.show_pace,
        showCover: !!q.data.show_cover,
        favoriteQuote: q.data.favorite_quote || "",
        shortReview: q.data.short_review || "",
      });
  }, [q.data?.id, q.data?.version]);
  async function save() {
    setBusy(true);
    try {
      await api(`/social/journeys/${q.data.id}`, "PATCH", {
        ...draft,
        expectedVersion: Number(q.data.version || 1),
      });
      await q.refetch();
      toast.success(ui("Reading Journey updated"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function token(action: "rotate" | "revoke") {
    if (busy || (action === "rotate" && !linkConfirmed)) return;
    setBusy(true);
    try {
      await api(`/social/journeys/${q.data.id}/share-token`, "POST", {
        action,
        expectedVersion: Number(q.data.version || 1),
        audienceConfirmed: action === "rotate" ? linkConfirmed : undefined,
      });
      setLinkConfirmed(false);
      await q.refetch();
      toast.success(
        action === "rotate"
          ? ui("Anyone-with-link access enabled")
          : ui("Anyone-with-link access disabled"),
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function share() {
    let ref = id;
    if (q.data.mine)
      ref = q.data.share_token && !q.data.share_revoked_at ? q.data.share_token : q.data.id;
    const url = `${location.origin}/community?journey=${encodeURIComponent(ref)}`;
    try {
      if (navigator.share)
        await navigator.share({
          title: `${q.data.title_snapshot} · Reading Journey`,
          text: `I finished ${q.data.title_snapshot} on Cove.`,
          url,
        });
      else {
        await navigator.clipboard.writeText(url);
        toast.success(ui("Share link copied"));
      }
    } catch {}
  }
  const shareReference =
    q.data?.mine && q.data?.share_token && !q.data?.share_revoked_at
      ? q.data.share_token
      : q.data?.id;
  const journeyUrl =
    typeof window === "undefined"
      ? ""
      : `${location.origin}/community?journey=${encodeURIComponent(String(shareReference || id))}`;
  const publicShareAvailable =
    q.data?.visibility === "public" && !!shareReference;
  function sharePlatform(platform: "x" | "reddit") {
    if (!publicShareAvailable) {
      toast.error("Make this journey public before posting its link to social media.");
      return;
    }
    const text = `I finished ${q.data.title_snapshot} · My Cove reading journey`;
    const target =
      platform === "x"
        ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(journeyUrl)}`
        : `https://www.reddit.com/submit?url=${encodeURIComponent(journeyUrl)}&title=${encodeURIComponent(text)}`;
    window.open(target, "_blank", "noopener,noreferrer");
  }
  async function makePng(): Promise<Blob> {
    const response = await fetch(
      `/api/fore/social/journeys/${encodeURIComponent(id)}/card.svg?format=${format}`,
      { credentials: "same-origin" },
    );
    if (!response.ok) throw new Error("Could not render journey image");
    const svg = await response.blob();
    const objectUrl = URL.createObjectURL(svg);
    const img = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Journey image could not load"));
        img.src = objectUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 1080;
      canvas.height = format === "story" ? 1920 : 1080;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas is unavailable");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      // Only same-origin, rights-controlled book covers may be composited.
      // External cover URLs cannot taint the canvas or leak account credentials.
      const cover = String(q.data.cover_url || "");
      if (q.data.show_cover && cover.startsWith("/api/fore/assets/")) {
        const coverImg = new Image();
        coverImg.crossOrigin = "anonymous";
        const loaded = await new Promise<boolean>((resolve) => {
          coverImg.onload = () => resolve(true);
          coverImg.onerror = () => resolve(false);
          coverImg.src = cover;
        });
        if (loaded) {
          ctx.save();
          ctx.shadowColor = "rgba(0,0,0,.45)";
          ctx.shadowBlur = 24;
          ctx.shadowOffsetY = 12;
          ctx.drawImage(coverImg, 90, format === "story" ? 360 : 350, 205, 280);
          ctx.restore();
        }
      }
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed"))),
          "image/png",
          0.94,
        ),
      );
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
  function downloadPng(png: Blob) {
    const url = URL.createObjectURL(png);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cove-${String(q.data.title_snapshot || "reading-journey")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}-${format}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportPng() {
    try {
      downloadPng(await makePng());
    } catch (error) {
      toast.error((error as Error).message);
    }
  }
  async function shareImage() {
    try {
      const png = await makePng();
      const file = new File([png], "cove-reading-journey.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: `${q.data.title_snapshot} · Cove Reading Journey`,
        });
      } else {
        downloadPng(png);
        toast.success("Image saved. Upload it to Instagram, Stories, or your favorite app.");
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") toast.error((error as Error).message);
    }
  }
  if (q.isError)
    return (
      <p role="alert">
        {ui("Reading Journey is unavailable or access was revoked.")}{" "}
        <button onClick={() => q.refetch()}>{ui("Retry")}</button>
      </p>
    );
  if (!q.data) return <p className="muted">{ui("Loading Reading Journey…")}</p>;
  const j = q.data,
    total = Number(j.read_seconds) + Number(j.listen_seconds);
  return (
    <section className="journey-page">
      <header>
        <span className="small-label">{ui("READING JOURNEY")}</span>
        <h1>{j.title_snapshot}</h1>
        <p>{j.author_snapshot}</p>
      </header>
      <div className="journey-layout">
        <div className="journey-preview">
          <div className="segmented">
            <button
              className={format === "square" ? "selected" : ""}
              onClick={() => setFormat("square")}
            >
              {ui("Square")}
            </button>
            <button
              className={format === "story" ? "selected" : ""}
              onClick={() => setFormat("story")}
            >
              {ui("Story")}
            </button>
          </div>
          <img
            src={`/api/fore/social/journeys/${encodeURIComponent(id)}/card.svg?format=${format}`}
            alt={`Shareable Reading Journey for ${j.title_snapshot}`}
          />
          <div className="journey-share-row">
            <button className="button gold" onClick={share}>
              <Share2 size={16} />{" "}
              {j.mine && j.share_token && !j.share_revoked_at
                ? ui("Share anyone-with-link URL")
                : ui("Share audience URL")}
            </button>
            <button className="button outline" onClick={shareImage}>
              <Share2 size={16} /> Share image · Instagram / Stories
            </button>
            <button
              className="button outline"
              onClick={() => sharePlatform("x")}
              disabled={!publicShareAvailable}
              title={publicShareAvailable ? "Post this public journey to X" : "Public journeys only"}
            >
              Share to X
            </button>
            <button
              className="button outline"
              onClick={() => sharePlatform("reddit")}
              disabled={!publicShareAvailable}
              title={publicShareAvailable ? "Submit this public journey on Reddit" : "Public journeys only"}
            >
              Share to Reddit
            </button>
            <button className="button outline" onClick={exportPng}>
              Download PNG
            </button>
            <a
              className="button outline"
              href={`/api/fore/social/journeys/${encodeURIComponent(id)}/card.svg?format=${format}`}
              download={`fore-${j.title_snapshot}-${format}.svg`}
            >
              {ui("Export SVG")}
            </a>
          </div>
          {j.mine && (
            <section className="journey-access" aria-label={ui("Journey access")}>
              <h2>{ui("Who can see this journey?")}</h2>
              <p>
                {ui("Current audience:")}{" "}
                <strong>
                  {j.visibility === "private"
                    ? ui("Private")
                    : j.visibility === "followers"
                      ? ui("Followers")
                      : ui("Public")}
                </strong>
                {ui(". Audience URLs follow this setting.")}
              </p>
              <h3>{ui("Share with a named member")}</h3>
              <p>
                {ui(
                  "Member links require that member to sign in. Choose Private in visibility settings for access limited to you and the members you grant.",
                )}
              </p>
              <MemberPicker
                value={member}
                onChange={(m) => {
                  setMember(m);
                  setMemberConfirmed(false);
                }}
              />
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={memberConfirmed}
                  disabled={!member}
                  onChange={(e) => setMemberConfirmed(e.target.checked)}
                />
                {ui("Grant access to")} {member ? `@${member.username}` : "the selected member"}
              </label>
              <button
                className="button outline"
                disabled={busy || !member || !memberConfirmed || grants.isLoading || grants.isError}
                onClick={grantMember}
              >
                {ui("Grant member access")}
              </button>
              {grants.isError && (
                <p role="alert">
                  {ui("Could not load member access.")}{" "}
                  <button onClick={() => grants.refetch()}>{ui("Retry")}</button>
                </p>
              )}
              {grants.data?.recipients
                .filter((g) => !g.revoked_at)
                .map((g) => (
                  <div key={g.recipient_user_id}>
                    <span>
                      @{g.member?.username || "member"} {ui("· Sign-in required")}
                    </span>
                    <button disabled={busy} onClick={() => copyMemberLink(g.share_token)}>
                      {ui("Copy member link")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => revokeMember(g.recipient_user_id, g.version)}
                    >
                      {ui("Revoke member access")}
                    </button>
                  </div>
                ))}
              <h3>{ui("Anyone with the link")}</h3>
              <p>
                {j.share_token && !j.share_revoked_at
                  ? "Enabled: anyone possessing this URL can view this journey. Private messages do not restrict its audience."
                  : "Disabled: copying an audience URL does not enable bearer access."}
              </p>
              {j.share_token && !j.share_revoked_at ? (
                <button disabled={busy} className="button outline" onClick={() => token("revoke")}>
                  {ui("Disable anyone-with-link access")}
                </button>
              ) : (
                <>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={linkConfirmed}
                      onChange={(e) => setLinkConfirmed(e.target.checked)}
                    />
                    {ui("I understand anyone possessing the link can view this journey.")}
                  </label>
                  <button
                    disabled={busy || !linkConfirmed}
                    className="button outline"
                    onClick={() => token("rotate")}
                  >
                    {ui("Enable anyone-with-link access")}
                  </button>
                </>
              )}
            </section>
          )}
          <div className="journey-timeline" aria-label={ui("Reading progress timeline")}>
            {j.points?.slice(-40).map((p: any, i: number) => (
              <span
                key={i}
                title={`${Math.round(p.progress * 100)}% · ${p.source} · ${when(p.at)}`}
                style={{ height: `${Math.max(8, Math.round(p.progress * 100))}%` }}
                className={`source-${p.source}`}
              />
            ))}
          </div>
        </div>
        <aside className="journey-summary">
          <h2>{ui("Your reading, not a race.")}</h2>
          <div className="journey-stat-grid">
            <span>
              <strong>{j.elapsed_days}</strong> {ui("days")}
            </span>
            <span>
              <strong>{j.session_count}</strong> {ui("sessions")}
            </span>
            <span>
              <strong>{duration(total)}</strong> {ui("active")}
            </span>
            <span>
              <strong>{j.highlights_count}</strong> {ui("highlights")}
            </span>
            <span>
              <strong>{j.notes_count}</strong> {ui("notes")}
            </span>
            <span>
              <strong>{j.bookmarks_count}</strong> {ui("bookmarks")}
            </span>
          </div>
          {j.mine && draft && (
            <div className="journey-controls">
              <label>
                {ui("Visibility")}
                <select
                  aria-label={ui("Journey visibility")}
                  value={draft.visibility}
                  onChange={(e) => setDraft({ ...draft, visibility: e.target.value })}
                >
                  <option value="public">{ui("Public")}</option>
                  <option value="followers">{ui("Followers")}</option>
                  <option value="private">{ui("Private")}</option>
                </select>
              </label>
              <label>
                {ui("Theme")}
                <select
                  value={draft.theme}
                  onChange={(e) => setDraft({ ...draft, theme: e.target.value })}
                >
                  {["paper", "night", "forest", "sunset", "ink"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              {[
                ["showRating", "Rating"],
                ["showTime", ui("Reading/listening time")],
                ["showDates", "Dates"],
                ["showPace", "Sessions/pace"],
                ["showCover", "Cover"],
              ].map(([key, label]) => (
                <label className="check-row" key={key}>
                  <input
                    type="checkbox"
                    checked={!!draft[key]}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
              <label>
                {ui("Favorite quote")}
                <textarea
                  value={draft.favoriteQuote}
                  onChange={(e) => setDraft({ ...draft, favoriteQuote: e.target.value })}
                  maxLength={1200}
                />
              </label>
              <label>
                {ui("Short review")}
                <textarea
                  value={draft.shortReview}
                  onChange={(e) => setDraft({ ...draft, shortReview: e.target.value })}
                  maxLength={1000}
                />
              </label>
              <button className="button gold" disabled={busy} onClick={save}>
                {ui("Save journey settings")}
              </button>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
function ListView({ id }: { id: string }) {
  const ui = useUiText();
  const { data, signIn } = useAccount();
  const storefront = useStorefrontLocale();
  const [addBook, setAddBook] = useState("");
  const q = useQuery<any>({
    queryKey: ["social-list", id],
    queryFn: () => api(`/social/lists/${encodeURIComponent(id)}`),
  });
  const [edit, setEdit] = useState<any>(null);
  useEffect(() => {
    if (q.data?.list)
      setEdit({
        title: q.data.list.title,
        description: q.data.list.description || "",
        visibility: q.data.list.visibility,
        ranked: !!q.data.list.ranked,
        commentsEnabled: !!q.data.list.comments_enabled,
      });
  }, [q.data?.list?.version]);
  async function action(kind: "like" | "save", active: boolean) {
    if (!data.user) return signIn();
    try {
      await api(`/social/lists/${id}/${kind}`, "POST", { active });
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function wish() {
    if (!data.user) return signIn();
    try {
      const r = await api<any>(`/social/lists/${id}/wishlist`, "POST", {
        territory: storefront.rightsCountry,
      });
      toast.success(`${r.saved} books added to your wishlist`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function replaceItems(items: any[]) {
    try {
      await api(`/social/lists/${id}/items`, "PUT", {
        items: items.map((i: any) => ({
          bookId: i.book?.productId || i.product_id,
          note: i.note || "",
        })),
        expectedVersion: Number(q.data.list.version || 1),
      });
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function add() {
    if (!addBook) return;
    const chosen = data.library.find((x) => (x.book.productId || x.productId) === addBook);
    if (!chosen) return;
    if (q.data.items.some((i: any) => i.book?.productId === addBook)) {
      toast.message(ui("That book is already in the list"));
      return;
    }
    await replaceItems([...q.data.items, { book: chosen.book, note: "" }]);
    setAddBook("");
  }
  async function saveMeta() {
    try {
      await api(`/social/lists/${id}`, "PATCH", {
        ...edit,
        expectedVersion: Number(q.data.list.version || 1),
      });
      await q.refetch();
      toast.success(ui("List updated"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function removeList() {
    if (!confirm("Remove this list? Its list discussion will also close.")) return;
    try {
      await api(`/social/lists/${id}`, "DELETE", {
        expectedVersion: Number(q.data.list.version || 1),
      });
      location.assign("/community?tab=me");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function moveItem(index: number, delta: number) {
    const next = [...q.data.items],
      target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await replaceItems(next);
  }
  async function shareList() {
    const url = `${location.origin}/community?list=${encodeURIComponent(id)}`;
    try {
      if (navigator.share)
        await navigator.share({
          title: q.data.list.title,
          text: q.data.list.description || `A reading list on Cove`,
          url,
        });
      else {
        await navigator.clipboard.writeText(url);
        toast.success(ui("List link copied"));
      }
    } catch {}
  }
  async function reportList() {
    if (!data.user) return signIn();
    try {
      await api("/social/report", "POST", {
        subjectType: "social_list",
        subjectId: id,
        reason: "other",
        details: "Reported from the reading-list interface for moderator review.",
      });
      toast.success(ui("List report sent to moderation"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  if (!q.data) return <p className="muted">{ui("Loading list…")}</p>;
  return (
    <section>
      <header className="social-detail-hero">
        <span className="small-label">{ui("READING LIST")}</span>
        <h1>{q.data.list.title}</h1>
        <p>{q.data.list.description}</p>
        <span>
          {ui("by")} {q.data.list.name || q.data.list.username}
        </span>
        <div>
          <button className="button outline" onClick={() => action("like", !q.data.liked)}>
            <Heart size={16} />
            {q.data.liked ? "Liked" : "Like"} · {q.data.list.likes}
          </button>
          <button className="button outline" onClick={() => action("save", !q.data.saved)}>
            <BookHeart size={16} />
            {q.data.saved ? ui("Saved") : ui("Save list")}
          </button>
          <button className="button outline" onClick={wish}>
            {ui("Add all to wishlist")}
          </button>
          <button className="button outline" onClick={shareList}>
            <Share2 size={16} /> {ui("Share")}
          </button>
          {!q.data.mine && (
            <button className="text-link" onClick={reportList}>
              {ui("Report")}
            </button>
          )}
        </div>
      </header>
      {q.data.mine && edit && (
        <section className="community-settings-card">
          <h2>{ui("List settings")}</h2>
          <label>
            {ui("Title")}
            <input
              value={edit.title}
              onChange={(e) => setEdit({ ...edit, title: e.target.value })}
            />
          </label>
          <label>
            {ui("Description")}
            <textarea
              value={edit.description}
              onChange={(e) => setEdit({ ...edit, description: e.target.value })}
            />
          </label>
          <label>
            {ui("Visibility")}
            <select
              value={edit.visibility}
              onChange={(e) => setEdit({ ...edit, visibility: e.target.value })}
            >
              <option value="public">{ui("Public")}</option>
              <option value="followers">{ui("Followers")}</option>
              <option value="private">{ui("Private")}</option>
            </select>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={edit.commentsEnabled}
              onChange={(e) => setEdit({ ...edit, commentsEnabled: e.target.checked })}
            />{" "}
            {ui("Allow comments")}
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={edit.ranked}
              onChange={(e) => setEdit({ ...edit, ranked: e.target.checked })}
            />{" "}
            {ui("Ranked list")}
          </label>
          <div className="inline-admin">
            <button className="button gold" onClick={saveMeta}>
              {ui("Save list")}
            </button>
            <button className="button outline" onClick={removeList}>
              {ui("Delete list")}
            </button>
          </div>
        </section>
      )}
      {q.data.mine && (
        <div className="inline-admin">
          <select value={addBook} onChange={(e) => setAddBook(e.target.value)}>
            <option value="">{ui("Add from your library…")}</option>
            {data.library.map((x) => (
              <option key={x.productId} value={x.book.productId || x.productId}>
                {x.book.title}
              </option>
            ))}
          </select>
          <button className="button outline" disabled={!addBook} onClick={add}>
            <Plus size={15} /> {ui("Add book")}
          </button>
        </div>
      )}
      <ol className="social-book-list">
        {q.data.items.map((i: any) => (
          <li key={i.product_id}>
            <span>{i.position + 1}</span>
            <a href={bookHref(i.book)}>
              <strong>{i.book?.title}</strong>
              <small>{i.book?.authors}</small>
              {i.note && <p>{i.note}</p>}
            </a>
            {q.data.mine && (
              <div className="list-item-controls">
                <button
                  className="text-link"
                  disabled={i.position === 0}
                  onClick={() => moveItem(i.position, -1)}
                  aria-label={`Move ${i.book?.title} up`}
                >
                  ↑
                </button>
                <button
                  className="text-link"
                  disabled={i.position === q.data.items.length - 1}
                  onClick={() => moveItem(i.position, 1)}
                  aria-label={`Move ${i.book?.title} down`}
                >
                  ↓
                </button>
                <button
                  className="text-link"
                  onClick={() =>
                    replaceItems(q.data.items.filter((x: any) => x.product_id !== i.product_id))
                  }
                >
                  {ui("Remove")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {q.data.list.comments_enabled ? (
        <DiscussionThread contextType="list" contextId={id} title={ui("List discussion")} />
      ) : null}
    </section>
  );
}
function ClubView({ id }: { id: string }) {
  const ui = useUiText();
  const { data, signIn } = useAccount();
  const q = useQuery<any>({
    queryKey: ["social-club", id],
    queryFn: () => api(`/social/groups/${encodeURIComponent(id)}`),
  });
  const [invite, setInvite] = useState("");
  const [book, setBook] = useState("");
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState("Yes\nNo");
  const [settings, setSettings] = useState<any>(null);
  useEffect(() => {
    if (q.data?.group)
      setSettings({
        name: q.data.group.name,
        description: q.data.group.description || "",
        visibility: q.data.group.visibility,
        joinPolicy: q.data.group.join_policy,
        spoilerPolicy: q.data.group.discussion_spoiler_policy,
        status: q.data.group.status,
        ownerUserId: q.data.group.owner_user_id,
      });
  }, [q.data?.group?.version]);
  async function join() {
    if (!data.user) return signIn();
    try {
      if (q.data.membership?.status === "invited")
        await api(`/social/groups/${id}/membership`, "POST", { action: "accept" });
      else await api(`/social/groups/${id}/join`, "POST", {});
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function membership(action: string, userId?: string) {
    try {
      await api(`/social/groups/${id}/membership`, "POST", { action, userId });
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function inviteUser() {
    try {
      await api(`/social/groups/${id}/invite`, "POST", { user: invite });
      setInvite("");
      toast.success(ui("Invitation sent"));
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function addBook() {
    try {
      await api(`/social/groups/${id}/books`, "POST", { bookId: book, status: "current" });
      setBook("");
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function createPoll() {
    try {
      await api(`/social/groups/${id}/polls`, "POST", {
        question: pollQuestion,
        options: pollOptions
          .split(/\n/)
          .map((x) => x.trim())
          .filter(Boolean),
        multipleChoice: false,
      });
      setPollQuestion("");
      await q.refetch();
      toast.success(ui("Poll created"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function saveSettings() {
    try {
      await api(`/social/groups/${id}`, "PATCH", {
        ...settings,
        expectedVersion: Number(q.data.group.version || 1),
      });
      await q.refetch();
      toast.success(ui("Reading group updated"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function removeGroup() {
    if (!confirm("Remove this reading group?")) return;
    try {
      await api(`/social/groups/${id}`, "DELETE", {
        expectedVersion: Number(q.data.group.version || 1),
      });
      location.assign("/community?tab=me");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function reportGroup() {
    if (!data.user) return signIn();
    try {
      await api("/social/report", "POST", {
        subjectType: "reading_group",
        subjectId: id,
        reason: "other",
        details: "Reported from the reading-group interface for moderator review.",
      });
      toast.success(ui("Reading-group report sent to moderation"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  if (!q.data) return <p className="muted">{ui("Loading reading group…")}</p>;
  const g = q.data.group,
    active = q.data.membership?.status === "active",
    moderator = ["owner", "moderator"].includes(q.data.membership?.role),
    owner = q.data.membership?.role === "owner";
  const current = q.data.books.find((b: any) => b.status === "current"),
    progressState = q.data.progress.find((x: any) => x.bookId === current?.id),
    dist = progressState?.buckets || [],
    viewerProgress = Number(progressState?.viewerProgress || 0);
  const canJoin = g.visibility !== "private" && g.join_policy !== "invite";
  return (
    <section>
      <header className="social-detail-hero">
        <span className="small-label">{g.group_type.replaceAll("_", " ").toUpperCase()}</span>
        <h1>{g.name}</h1>
        <p>{g.description}</p>
        <div className="profile-stat-row">
          <span>
            <strong>{g.member_count}</strong> {ui("members")}
          </span>
          <span>
            {g.discussion_spoiler_policy} {ui("spoiler protection")}
          </span>
        </div>
        {!active && (q.data.membership?.status === "invited" || canJoin) && (
          <button
            className="button gold"
            disabled={q.data.membership?.status === "requested"}
            onClick={join}
          >
            {q.data.membership?.status === "requested"
              ? ui("Request pending")
              : q.data.membership?.status === "invited"
                ? ui("Accept invitation")
                : ui("Join group")}
          </button>
        )}
        {!active && g.visibility === "private" && q.data.membership?.status !== "invited" && (
          <p className="muted">{ui("This private group is invitation-only.")}</p>
        )}
        {data.user && q.data.membership?.role !== "owner" && (
          <button className="text-link" onClick={reportGroup}>
            {ui("Report group")}
          </button>
        )}
      </header>
      {moderator && settings && (
        <section className="community-settings-card">
          <h2>{ui("Group settings")}</h2>
          <label>
            {ui("Name")}
            <input
              value={settings.name}
              onChange={(e) => setSettings({ ...settings, name: e.target.value })}
            />
          </label>
          <label>
            {ui("Description")}
            <textarea
              value={settings.description}
              onChange={(e) => setSettings({ ...settings, description: e.target.value })}
            />
          </label>
          <label>
            {ui("Visibility")}
            <select
              value={settings.visibility}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  visibility: e.target.value,
                  joinPolicy: e.target.value === "private" ? "invite" : settings.joinPolicy,
                })
              }
            >
              <option value="public">{ui("Public")}</option>
              <option value="unlisted">{ui("Unlisted")}</option>
              <option value="private">{ui("Private")}</option>
            </select>
          </label>
          <label>
            {ui("Join policy")}
            <select
              disabled={settings.visibility === "private"}
              value={settings.visibility === "private" ? "invite" : settings.joinPolicy}
              onChange={(e) => setSettings({ ...settings, joinPolicy: e.target.value })}
            >
              <option value="open">{ui("Open")}</option>
              <option value="request">{ui("Request approval")}</option>
              <option value="invite">{ui("Invite only")}</option>
            </select>
          </label>
          <label>
            {ui("Spoiler policy")}
            <select
              value={settings.spoilerPolicy}
              onChange={(e) => setSettings({ ...settings, spoilerPolicy: e.target.value })}
            >
              <option value="progress">{ui("Progress-aware")}</option>
              <option value="chapter">{ui("Chapter-aware")}</option>
              <option value="manual">{ui("Manual spoiler tags")}</option>
            </select>
          </label>
          {owner && (
            <>
              <label>
                {ui("Owner")}
                <select
                  value={settings.ownerUserId}
                  onChange={(e) => setSettings({ ...settings, ownerUserId: e.target.value })}
                >
                  {q.data.members.map((m: any) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.name || m.username || m.user_id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {ui("Status")}
                <select
                  value={settings.status}
                  onChange={(e) => setSettings({ ...settings, status: e.target.value })}
                >
                  <option value="active">{ui("Active")}</option>
                  <option value="archived">{ui("Archived")}</option>
                </select>
              </label>
            </>
          )}
          <div className="inline-admin">
            <button className="button gold" onClick={saveSettings}>
              {ui("Save settings")}
            </button>
            {owner && (
              <button className="button outline" onClick={removeGroup}>
                {ui("Delete group")}
              </button>
            )}
          </div>
        </section>
      )}
      {current && (
        <section className="club-current">
          <span className="small-label">{ui("NOW READING")}</span>
          <h2>{current.title_snapshot}</h2>
          <p className="small muted">
            {ui(
              "Group positions combine saved ebook reading with verified audio-to-ebook percentage mappings. Audio editions without a percentage mapping are not counted as text progress.",
            )}
          </p>
          <div className="club-progress-buckets">
            {dist.map((b: any) => (
              <span key={b.bucket}>
                <strong>{b.count}</strong>
                {String(b.bucket).replaceAll("_", " ")}
              </span>
            ))}
          </div>
        </section>
      )}
      <section>
        <h2>{ui("Reading schedule")}</h2>
        <div className="social-book-list">
          {q.data.books.map((b: any) => (
            <article key={b.id}>
              <span className="status-pill">{b.status}</span>
              <strong>{b.title_snapshot}</strong>
              <small>
                {[
                  b.starts_at && `Starts ${when(b.starts_at)}`,
                  b.ends_at && `Ends ${when(b.ends_at)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </article>
          ))}
        </div>
        {moderator && (
          <div className="inline-admin">
            <input
              value={book}
              onChange={(e) => setBook(e.target.value)}
              placeholder={ui("Cove product ID to make current")}
            />
            <button className="button outline" onClick={addBook}>
              {ui("Set current book")}
            </button>
          </div>
        )}
      </section>
      <section>
        <h2>{ui("Members")}</h2>
        <div className="member-row-list">
          {q.data.members.map((m: any) => (
            <div className="member-management-row" key={m.user_id}>
              <a href={`/community?profile=${encodeURIComponent(m.username || m.user_id)}`}>
                <span className="social-avatar">
                  {String(m.name || m.username || "R").slice(0, 1)}
                </span>
                <span>
                  <strong>{m.name || m.username}</strong>
                  <small>{m.role}</small>
                </span>
              </a>
              {moderator && m.user_id !== g.owner_user_id && (
                <div>
                  {owner && (
                    <button
                      className="text-link"
                      onClick={() =>
                        membership(m.role === "moderator" ? "demote" : "promote", m.user_id)
                      }
                    >
                      {m.role === "moderator" ? "Demote" : ui("Make moderator")}
                    </button>
                  )}
                  <button className="text-link" onClick={() => membership("remove", m.user_id)}>
                    {ui("Remove")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        {moderator && (
          <div className="inline-admin">
            <input
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              placeholder="@username"
            />
            <button className="button outline" onClick={inviteUser}>
              {ui("Invite reader")}
            </button>
          </div>
        )}
        {moderator && q.data.pendingMembers?.length > 0 && (
          <div className="pending-members">
            <h3>{ui("Pending")}</h3>
            {q.data.pendingMembers.map((m: any) => (
              <div key={m.user_id}>
                <span>
                  {m.name || m.username} · {m.status}
                </span>
                {m.status === "requested" && (
                  <>
                    <button className="text-link" onClick={() => membership("approve", m.user_id)}>
                      {ui("Approve")}
                    </button>
                    <button className="text-link" onClick={() => membership("remove", m.user_id)}>
                      {ui("Decline")}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {active && !owner && (
          <button className="text-link" onClick={() => membership("leave")}>
            {ui("Leave group")}
          </button>
        )}
      </section>
      {active && (
        <DiscussionThread
          contextType="group"
          contextId={id}
          progress={viewerProgress}
          title={ui("Club room")}
        />
      )}
      <section>
        <h2>{ui("Polls")}</h2>
        {active && (
          <div className="poll-composer">
            <input
              value={pollQuestion}
              onChange={(e) => setPollQuestion(e.target.value)}
              placeholder={ui("Ask the club a question…")}
            />
            <textarea
              value={pollOptions}
              onChange={(e) => setPollOptions(e.target.value)}
              aria-label={ui("Poll options, one per line")}
            />
            <button
              className="button outline"
              disabled={
                !pollQuestion.trim() || pollOptions.split(/\n/).filter((x) => x.trim()).length < 2
              }
              onClick={createPoll}
            >
              {ui("Create poll")}
            </button>
          </div>
        )}
        <div className="journey-mini-grid">
          {q.data.polls.map((p: any) => (
            <a href={`/community?club=${id}&poll=${p.id}`} key={p.id}>
              <strong>{p.question}</strong>
              <span>{p.multiple_choice ? ui("Choose several") : ui("Choose one")}</span>
            </a>
          ))}
        </div>
      </section>
    </section>
  );
}
function PollView({ id, clubId }: { id: string; clubId: string }) {
  const ui = useUiText();
  const { data, signIn } = useAccount();
  const q = useQuery<any>({
    queryKey: ["social-poll", id],
    queryFn: () => api(`/social/polls/${encodeURIComponent(id)}`),
  });
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (q.data) setSelected(q.data.myVotes || []);
  }, [q.data?.poll?.id, JSON.stringify(q.data?.myVotes || [])]);
  if (!q.data) return <p className="muted">{ui("Loading poll…")}</p>;
  const { poll, options } = q.data,
    closed = !!poll.closes_at && Date.parse(poll.closes_at) <= Date.now(),
    total = options.reduce((n: number, o: any) => n + Number(o.votes || 0), 0);
  function choose(optionId: string) {
    if (closed) return;
    if (poll.multiple_choice)
      setSelected((v) =>
        v.includes(optionId) ? v.filter((x) => x !== optionId) : [...v, optionId],
      );
    else setSelected([optionId]);
  }
  async function vote() {
    if (!data.user) return signIn();
    if (!selected.length) return;
    try {
      await api(`/social/polls/${encodeURIComponent(id)}/vote`, "POST", { optionIds: selected });
      await q.refetch();
      toast.success(ui("Vote saved"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <section className="journey-page">
      <header className="social-detail-hero">
        <span className="small-label">{ui("BOOK CLUB POLL")}</span>
        <h1>{poll.question}</h1>
        <p>
          {closed
            ? ui("Voting is closed.")
            : poll.multiple_choice
              ? ui("Choose one or more options.")
              : ui("Choose one option.")}
        </p>
        <a className="text-link" href={`/community?club=${encodeURIComponent(clubId)}`}>
          {ui("Back to reading group")}
        </a>
      </header>
      <div className="poll-detail-options">
        {options.map((o: any) => {
          const active = selected.includes(o.id),
            pct = total ? Math.round((Number(o.votes || 0) * 100) / total) : 0;
          return (
            <button
              key={o.id}
              className={`poll-option ${active ? "selected" : ""}`}
              onClick={() => choose(o.id)}
              disabled={closed}
            >
              <span>
                <strong>{o.label}</strong>
                <small>
                  {o.votes} {ui("vote")}
                  {o.votes === 1 ? "" : "s"} · {pct}%
                </small>
              </span>
              <i aria-hidden="true" style={{ width: `${pct}%` }} />
            </button>
          );
        })}
      </div>
      {!closed && (
        <button className="button gold" onClick={vote} disabled={!selected.length}>
          {ui("Save vote")}
        </button>
      )}
      <p className="muted">
        {total} {ui("vote")}
        {total === 1 ? "" : "s"} {ui("total")}
        {poll.closes_at ? ` · closes ${when(poll.closes_at)}` : ""}
      </p>
    </section>
  );
}

function MyCommunity() {
  const ui = useUiText();
  const { data } = useAccount();
  const q = useQuery<any>({
    queryKey: ["social-me", data.user?.id],
    queryFn: () => api("/social/me"),
    enabled: !!data.user,
  });
  const [profile, setProfile] = useState<any>(null);
  const [three, setThree] = useState<string[]>(["", "", ""]);
  const [listTitle, setListTitle] = useState("");
  const [listVisibility, setListVisibility] = useState("public");
  const [clubName, setClubName] = useState("");
  const [clubType, setClubType] = useState("club");
  const [clubVisibility, setClubVisibility] = useState("private");
  const [clubJoin, setClubJoin] = useState("invite");
  useEffect(() => {
    if (q.data) {
      const p = q.data.profile;
      setProfile({
        bio: p.bio || "",
        profileVisibility: p.profile_visibility || "public",
        followPolicy: p.follow_policy || "open",
        repliesPolicy: p.replies_policy || "following",
        activityVisibility: p.activity_visibility || "followers",
        journeyVisibilityDefault: p.journey_visibility_default || "followers",
        highlightVisibilityDefault: p.highlight_visibility_default || "private",
        showCurrentlyReading: !!p.show_currently_reading,
      });
      const x = ["", "", ""];
      for (const b of q.data.topBooks || []) x[b.position - 1] = b.book?.productId || "";
      setThree(x);
    }
  }, [q.data?.profile?.version]);
  if (!data.user)
    return (
      <p className="notice">
        {ui(
          "Sign in to create your reader profile, follow people, share journeys, and join reading groups.",
        )}
      </p>
    );
  async function saveProfile() {
    try {
      await api("/social/profile", "POST", {
        ...profile,
        expectedVersion: Number(q.data.profile.version || 1),
      });
      toast.success(ui("Reader profile updated"));
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function saveThree() {
    try {
      await api("/social/top-books", "POST", { productIds: three.filter(Boolean) });
      toast.success(ui("The Three updated"));
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function followRequest(requesterUserId: string, action: "accept" | "decline") {
    try {
      await api("/social/follow-requests", "POST", { requesterUserId, action });
      await q.refetch();
      toast.success(action === "accept" ? ui("Follower approved") : ui("Request declined"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function unblock(userId: string) {
    try {
      await api("/social/block", "POST", { userId, blocked: false });
      await q.refetch();
      toast.success(ui("Reader unblocked"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function generate() {
    const r = await api<any>("/social/journeys/generate", "POST", {});
    toast.success(
      r.generated.length
        ? `${r.generated.length} Reading Journey${r.generated.length === 1 ? "" : "s"} created`
        : ui("Your finished books already have journeys"),
    );
    await q.refetch();
  }
  async function createList() {
    const r = await api<any>("/social/lists", "POST", {
      title: listTitle,
      description: "",
      visibility: listVisibility,
      ranked: true,
      commentsEnabled: true,
    });
    location.assign(`/community?list=${r.id}`);
  }
  async function createClub() {
    const visibility = clubVisibility,
      joinPolicy = visibility === "private" ? "invite" : clubJoin;
    const r = await api<any>("/social/groups", "POST", {
      name: clubName,
      description: "",
      groupType: clubType,
      visibility,
      joinPolicy,
      spoilerPolicy: "progress",
    });
    location.assign(`/community?club=${r.id}`);
  }
  const options = data.library.map((l) => ({
    id: l.book.productId || l.productId,
    title: l.book.title,
  }));
  return (
    <section>
      <div className="social-page-heading">
        <div>
          <span className="small-label">{ui("YOUR SOCIAL READING")}</span>
          <h1>{q.data?.person?.name || data.user.name}</h1>
          <p>@{q.data?.person?.username || data.user.username}</p>
        </div>
        <a
          className="button outline"
          href={`/community?profile=${encodeURIComponent(q.data?.person?.username || data.user.id)}`}
        >
          {ui("View public profile")}
        </a>
      </div>
      <div className="community-settings-grid">
        <section className="community-settings-card">
          <h2>{ui("Profile & privacy")}</h2>
          {profile && (
            <>
              <label>
                {ui("Bio")}
                <textarea
                  value={profile.bio}
                  onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
                  maxLength={1200}
                />
              </label>
              <label>
                {ui("Profile visibility")}
                <select
                  value={profile.profileVisibility}
                  onChange={(e) => setProfile({ ...profile, profileVisibility: e.target.value })}
                >
                  <option value="public">{ui("Public")}</option>
                  <option value="followers">{ui("Followers")}</option>
                  <option value="private">{ui("Private")}</option>
                </select>
              </label>
              <label>
                {ui("Who can follow")}
                <select
                  value={profile.followPolicy}
                  onChange={(e) => setProfile({ ...profile, followPolicy: e.target.value })}
                >
                  <option value="open">{ui("Anyone")}</option>
                  <option value="request">{ui("Approve requests")}</option>
                  <option value="closed">{ui("No new followers")}</option>
                </select>
              </label>
              <label>
                {ui("Profile replies")}
                <select
                  value={profile.repliesPolicy}
                  onChange={(e) => setProfile({ ...profile, repliesPolicy: e.target.value })}
                >
                  <option value="everyone">{ui("Everyone")}</option>
                  <option value="following">{ui("People who follow me")}</option>
                  <option value="mutuals">{ui("Mutuals")}</option>
                  <option value="none">{ui("Nobody")}</option>
                </select>
              </label>
              <label>
                {ui("Activity visibility")}
                <select
                  value={profile.activityVisibility}
                  onChange={(e) => setProfile({ ...profile, activityVisibility: e.target.value })}
                >
                  <option value="public">{ui("Public")}</option>
                  <option value="followers">{ui("Followers")}</option>
                  <option value="private">{ui("Private")}</option>
                </select>
              </label>
              <label>
                {ui("Journey default")}
                <select
                  value={profile.journeyVisibilityDefault}
                  onChange={(e) =>
                    setProfile({ ...profile, journeyVisibilityDefault: e.target.value })
                  }
                >
                  <option value="public">{ui("Public")}</option>
                  <option value="followers">{ui("Followers")}</option>
                  <option value="private">{ui("Private")}</option>
                </select>
              </label>
              <label>
                {ui("Shared-highlight default")}
                <select
                  value={profile.highlightVisibilityDefault}
                  onChange={(e) =>
                    setProfile({ ...profile, highlightVisibilityDefault: e.target.value })
                  }
                >
                  <option value="public">{ui("Public")}</option>
                  <option value="followers">{ui("Followers")}</option>
                  <option value="friends">{ui("Friends")}</option>
                  <option value="private">{ui("Private")}</option>
                </select>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={profile.showCurrentlyReading}
                  onChange={(e) =>
                    setProfile({ ...profile, showCurrentlyReading: e.target.checked })
                  }
                />{" "}
                {ui("Show my current book to allowed readers")}
              </label>
              <button className="button gold" onClick={saveProfile}>
                {ui("Save profile")}
              </button>
            </>
          )}
        </section>
        {!!q.data?.followRequests?.length && (
          <section className="community-settings-card">
            <h2>{ui("Follow requests")}</h2>
            {q.data.followRequests.map((r: any) => (
              <div className="member-management-row" key={r.requester_user_id}>
                <a
                  href={`/community?profile=${encodeURIComponent(r.username || r.requester_user_id)}`}
                >
                  <strong>{r.name || r.username || "Reader"}</strong>
                  <small>@{r.username || "reader"}</small>
                </a>
                <div>
                  <button
                    className="text-link"
                    onClick={() => followRequest(r.requester_user_id, "accept")}
                  >
                    {ui("Accept")}
                  </button>
                  <button
                    className="text-link"
                    onClick={() => followRequest(r.requester_user_id, "decline")}
                  >
                    {ui("Decline")}
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}
        {!!q.data?.blockedReaders?.length && (
          <section className="community-settings-card">
            <h2>{ui("Blocked readers")}</h2>
            <p className="muted">
              {ui(
                "Blocked readers cannot follow you, view your social activity, or interact with your Community content.",
              )}
            </p>
            {q.data.blockedReaders.map((r: any) => (
              <div className="member-management-row" key={r.blocked_user_id}>
                <span>
                  <strong>{r.name || r.username || "Reader"}</strong>
                  <small>@{r.username || "reader"}</small>
                </span>
                <button className="text-link" onClick={() => unblock(r.blocked_user_id)}>
                  {ui("Unblock")}
                </button>
              </div>
            ))}
          </section>
        )}
        <section className="community-settings-card">
          <h2>{ui("The Three")}</h2>
          <p className="muted">
            {ui("Choose up to three books that say the most about your taste.")}
          </p>
          {three.map((v, i) => (
            <label key={i}>
              {i + 1}
              <select
                value={v}
                onChange={(e) => setThree(three.map((x, n) => (n === i ? e.target.value : x)))}
              >
                <option value="">{ui("Choose a book")}</option>
                {options.map((o) => (
                  <option value={o.id} key={o.id}>
                    {o.title}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button className="button gold" onClick={saveThree}>
            {ui("Save The Three")}
          </button>
        </section>
        <section className="community-settings-card">
          <h2>{ui("Reading Journeys")}</h2>
          <p>
            {q.data?.journeys?.length || 0} {ui("finished-book artifacts.")}
          </p>
          <button className="button outline" onClick={generate}>
            <WandSparkles size={16} /> {ui("Generate missing journeys")}
          </button>
          <div className="journey-mini-grid">
            {q.data?.journeys?.slice(0, 6).map((j: any) => (
              <a key={j.id} href={`/community?journey=${j.id}`}>
                <strong>{j.title_snapshot}</strong>
                <span>{when(j.finished_at)}</span>
              </a>
            ))}
          </div>
        </section>
        <section className="community-settings-card">
          <h2>{ui("Create a list")}</h2>
          <input
            value={listTitle}
            onChange={(e) => setListTitle(e.target.value)}
            placeholder={ui("Books that feel like autumn")}
          />
          <label>
            {ui("Visibility")}
            <select value={listVisibility} onChange={(e) => setListVisibility(e.target.value)}>
              <option value="public">{ui("Public")}</option>
              <option value="followers">{ui("Followers")}</option>
              <option value="private">{ui("Private")}</option>
            </select>
          </label>
          <button className="button outline" disabled={!listTitle.trim()} onClick={createList}>
            {ui("Create reading list")}
          </button>
          <h3>{ui("Your lists")}</h3>
          {q.data?.lists?.map((l: any) => (
            <a className="text-link" href={`/community?list=${l.id}`} key={l.id}>
              {l.title} · {l.item_count} {ui("books")}
            </a>
          ))}
        </section>
        <section className="community-settings-card">
          <h2>{ui("Create a reading group")}</h2>
          <input
            value={clubName}
            onChange={(e) => setClubName(e.target.value)}
            placeholder={ui("Saturday sci-fi club")}
          />
          <label>
            {ui("Group type")}
            <select value={clubType} onChange={(e) => setClubType(e.target.value)}>
              <option value="buddy">{ui("Buddy read")}</option>
              <option value="private_group">{ui("Private group")}</option>
              <option value="club">{ui("Book club")}</option>
            </select>
          </label>
          <label>
            {ui("Visibility")}
            <select
              value={clubVisibility}
              onChange={(e) => {
                setClubVisibility(e.target.value);
                if (e.target.value === "private") setClubJoin("invite");
              }}
            >
              <option value="private">{ui("Private")}</option>
              <option value="unlisted">{ui("Unlisted")}</option>
              <option value="public">{ui("Public")}</option>
            </select>
          </label>
          <label>
            {ui("Joining")}
            <select
              value={clubVisibility === "private" ? "invite" : clubJoin}
              disabled={clubVisibility === "private"}
              onChange={(e) => setClubJoin(e.target.value)}
            >
              <option value="open">{ui("Open")}</option>
              <option value="request">{ui("Request approval")}</option>
              <option value="invite">{ui("Invite only")}</option>
            </select>
          </label>
          <button className="button outline" disabled={!clubName.trim()} onClick={createClub}>
            {ui("Create reading group")}
          </button>
          <h3>{ui("Your groups")}</h3>
          {q.data?.groups?.map((g: any) => (
            <a className="text-link" href={`/community?club=${g.id}`} key={g.id}>
              {g.name} · {g.member_status}
            </a>
          ))}
        </section>
      </div>
    </section>
  );
}
export function CommunityPage() {
  const ui = useUiText();
  const { data, signIn } = useAccount();
  const searchString = useRouterState({ select: (state) => state.location.searchStr || "" });
  const params = new URLSearchParams(searchString),
    profile = params.get("profile"),
    journey = params.get("journey"),
    list = params.get("list"),
    club = params.get("club"),
    poll = params.get("poll"),
    focusedThread = params.get("thread"),
    focusedWork = params.get("work");
  const tab = params.get("tab") || "feed";
  if (
    focusedThread &&
    focusedWork &&
    /^[a-zA-Z0-9_-]{1,240}$/.test(focusedThread) &&
    /^[a-zA-Z0-9_-]{1,240}$/.test(focusedWork)
  )
    return (
      <main className="cove-book-thread-focus">
        <a className="text-link" href={`/work/${encodeURIComponent(focusedWork)}`}>
          ← Back to the book
        </a>
        <h1>Conversation</h1>
        <p className="muted">Follow this branch without losing reading width to indentation.</p>
        <DiscussionThread
          contextType="work"
          contextId={focusedWork}
          postId={focusedThread}
          bookThread
          depth={2}
          title="Parent comment"
        />
        <DiscussionThread
          contextType="work"
          contextId={focusedWork}
          parentId={focusedThread}
          bookThread
          depth={0}
          title="Replies"
        />
      </main>
    );
  if (profile) return <PublicProfile ref={profile} />;
  if (journey) return <Journey id={journey} />;
  if (list) return <ListView id={list} />;
  if (club && poll) return <PollView id={poll} clubId={club} />;
  if (club) return <ClubView id={club} />;
  return (
    <main className="community-page">
      <header className="community-banner">
        <div>
          <span className="small-label">{ui("FORE COMMUNITY")}</span>
          <h1>{ui("Read together without leaving the book.")}</h1>
          <p>
            {ui(
              "Follow readers, share finished-book journeys, compare The Three, and opt into quiet, progress-aware conversations inside the books you are actually reading.",
            )}
          </p>
        </div>
        <Sparkles size={54} />
      </header>
      <nav className="community-tabs" aria-label={ui("Community sections")}>
        {[
          ["feed", Activity, ui("Activity")],
          ["discover", Users, ui("Discover")],
          ["received", BookHeart, ui("Shared with me")],
          ["sharing", Share2, ui("My sharing")],
          ["me", CircleUserRound, ui("My profile")],
        ].map(([key, Icon, label]: any) => (
          <a
            className={tab === key ? "active" : ""}
            href={`/community?tab=${key}`}
            key={key}
            aria-current={tab === key ? "page" : undefined}
          >
            <Icon size={17} />
            {label}
          </a>
        ))}
      </nav>
      {tab === "sharing" ? (
        <SharingPage sent />
      ) : tab === "received" ? (
        <SharingPage />
      ) : tab === "discover" ? (
        <Discover />
      ) : tab === "me" ? (
        <MyCommunity />
      ) : data.user ? (
        <Feed />
      ) : (
        <section className="community-signin">
          <Users size={42} />
          <h2>{ui("Your reading circle starts here.")}</h2>
          <p>
            {ui(
              "Sign in to follow readers, share Reading Journeys, and join spoiler-aware conversations.",
            )}
          </p>
          <button className="button gold" onClick={signIn}>
            {ui("Sign in")}
          </button>
          <Discover />
        </section>
      )}
    </main>
  );
}
