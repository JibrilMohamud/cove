import { CoveRequestError } from "./api-transport";
import { AddToShelf } from "./Shelves";
import { OfflineDownloads } from "./Audio";
import { queueReaderMutation } from "./offline-reader-mutations";
import { AccountManagementPanel } from "./AccountManagement";
import { useState, useRef, useEffect, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Plus,
  Upload,
  Library,
  Search,
  Highlighter,
  BookA,
  ArrowUpRight,
  Download,
  Trash2,
  Pencil,
  Volume2,
  Loader2,
  ArrowRight,
  LogOut,
  UserRound,
  Check,
  FileDown,
  ShieldCheck,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  api,
  useAccount,
  authorOf,
  readPath,
  bookPath,
  colors,
  downloadBlob,
  type Annotation,
  type Definition,
  type LibraryBook,
} from "./client";
import { BookArt } from "./Store";
import { useStorefrontLocale } from "./localization";
import { inspectEpub, downloadBook, exportReadingData, downloadCoveBackup } from "./epub";
import type { HighlightShareAudience, HighlightShareState } from "./Sharing";
// Render a single bounded page rather than accumulating thousands of private
// annotations/definitions in React state. Every request is tied to the account
// identity that initiated it, including when an account switch races a fetch.
function usePagedAccountCollection<T extends { id?: string; bookId?: string }>(
  kind: "library" | "annotations" | "definitions",
  firstPage: T[],
  accountId: string | undefined,
  searchQuery = "",
  statusFilter = "all",
) {
  type Page = { scope: string; items: T[]; offset: number; hasMore: boolean };
  const query = searchQuery.trim();
  const filtered = Boolean(query || (kind === "library" && statusFilter !== "all"));
  const scope = JSON.stringify([accountId || "guest", kind, query, statusFilter]);
  const scopeRef = useRef(scope);
  if (scopeRef.current !== scope) scopeRef.current = scope;
  const requestRef = useRef(0);
  const initial: Page = {
    scope,
    offset: 0,
    items: filtered ? [] : firstPage,
    hasMore: !filtered && firstPage.length >= 100,
  };
  const [page, setPage] = useState<Page>(initial);
  const [loading, setLoading] = useState(false);

  function endpoint(offset: number) {
    const params = new URLSearchParams({
      kind,
      offset: String(offset),
      limit: "100",
    });
    if (query) params.set("q", query);
    if (kind === "library" && statusFilter !== "all") params.set("status", statusFilter);
    return "/account/collection?" + params.toString();
  }

  useEffect(() => {
    // The account/filter identity is part of the request; never show an
    // older account's private response while a new account is loading.
    const token = ++requestRef.current;
    setLoading(false);
    setPage({
      scope,
      offset: 0,
      items: filtered ? [] : firstPage,
      hasMore: !filtered && firstPage.length >= 100,
    });
    if (!filtered || !accountId) return;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void api<{ items: T[]; hasMore: boolean }>(endpoint(0))
        .then((response) => {
          if (scopeRef.current !== scope || requestRef.current !== token) return;
          setPage({ scope, offset: 0, items: response.items, hasMore: response.hasMore });
        })
        .catch((error) => {
          if (scopeRef.current === scope && requestRef.current === token)
            toast.error((error as Error).message);
        })
        .finally(() => {
          if (scopeRef.current === scope && requestRef.current === token)
            setLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [scope, filtered, accountId]);

  useEffect(() => {
    if (filtered) return;
    setPage((current) =>
      current.scope === scope && current.offset === 0
        ? { scope, offset: 0, items: firstPage, hasMore: firstPage.length >= 100 }
        : current,
    );
  }, [scope, filtered, firstPage]);

  const visible = page.scope === scope ? page : initial;
  async function navigate(offset: number) {
    if (!accountId || loading || offset < 0) return;
    if (offset === 0 && !filtered) {
      requestRef.current += 1;
      setPage({ scope, offset: 0, items: firstPage, hasMore: firstPage.length >= 100 });
      return;
    }
    setLoading(true);
    const token = ++requestRef.current;
    try {
      const response = await api<{ items: T[]; hasMore: boolean }>(endpoint(offset));
      if (scopeRef.current !== scope || requestRef.current !== token) return;
      setPage({ scope, offset, items: response.items, hasMore: response.hasMore });
    } catch (error) {
      if (scopeRef.current === scope && requestRef.current === token)
        toast.error((error as Error).message);
    } finally {
      if (scopeRef.current === scope && requestRef.current === token)
        setLoading(false);
    }
  }
  return {
    items: visible.items,
    hasMore: visible.hasMore,
    hasPrevious: visible.offset > 0,
    pageNumber: Math.floor(visible.offset / 100) + 1,
    loading,
    loadMore: () => navigate(visible.offset + 100),
    loadPrevious: () => navigate(Math.max(0, visible.offset - 100)),
  };
}
function CollectionNextPage({
  state,
}: {
  state: {
    hasMore: boolean;
    hasPrevious: boolean;
    pageNumber: number;
    loading: boolean;
    loadMore: () => Promise<void>;
    loadPrevious: () => Promise<void>;
  };
}) {
  const { t: tr } = useStorefrontLocale();
  if (!state.hasMore && !state.hasPrevious) return null;
  return (
    <nav
      className="collection-load-more"
      aria-label={tr("collection.pagination", "Collection pages")}
    >
      <button
        type="button"
        className="button outline"
        disabled={state.loading || !state.hasPrevious}
        onClick={() => void state.loadPrevious()}
      >
        {tr("collection.previous", "Previous page")}
      </button>
      <span aria-live="polite">
        {tr("collection.page", "Page")} {state.pageNumber}
      </span>
      <button
        type="button"
        className="button outline"
        disabled={state.loading || !state.hasMore}
        onClick={() => void state.loadMore()}
      >
        {state.loading
          ? tr("collection.loadingMore", "Loading…")
          : tr("collection.next", "Next page")}
      </button>
    </nav>
  );
}
export function AccountGuard({ children }: { children: ReactNode }) {
  const { t: tr } = useStorefrontLocale();
  const { data, loading, error, reload, signIn } = useAccount();
  if (loading)
    return (
      <div className="empty-state">
        <Loader2 className="spin" />
        <p>{tr("account.loading", "Opening your reading room…")}</p>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h2>{tr("account.loadingError", "Your reading room needs a moment.")}</h2>
        <p>{error}</p>
        <button className="button gold" onClick={reload}>
          {tr("common.retry", "Try again")}
        </button>
      </div>
    );
  if (!data.user)
    return (
      <div className="empty-state account-empty">
        <Library />
        <span className="page-eyebrow">A PLACE FOR YOUR READING LIFE</span>
        <h2>{tr("account.welcome", "Make yourself at home.")}</h2>
        <p>
          Sign in to build your library and keep your favorite passages, notes, and new words
          together.
        </p>
        <button className="button gold" onClick={signIn}>
          {tr("account.signIn", "Create an account or log in")} <ArrowUpRight size={17} />
        </button>
      </div>
    );
  return <>{children}</>;
}
export function LibraryPage() {
  const { t: tr } = useStorefrontLocale();
  const { data, reload } = useAccount();
  const [filter, setFilter] = useState("all"),
    [q, setQ] = useState(""),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const pages = usePagedAccountCollection<LibraryBook>("library", data.library, data.user?.id, q, filter);
  const books = pages.items.filter(
    (x) =>
      (filter === "all" || x.status === filter) &&
      (!q ||
        [x.book.title, authorOf(x.book), ...x.shelves]
          .join(" ")
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
  async function upload(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".epub") || file.size > 25 * 1024 * 1024) {
      toast.error("Choose a DRM-free EPUB, up to 25 MB.");
      return;
    }
    setBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      const meta = await inspectEpub(bytes);
      const p = new URLSearchParams({
        title: meta.title,
        author: meta.author,
        language: meta.language,
      });
      const r = await fetch("/api/fore/upload?" + p, {
        method: "POST",
        headers: { "Content-Type": "application/epub+zip" },
        body: bytes,
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error);
      await reload();
      toast.success("Your EPUB is in your library");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <>
      <div className="page-eyebrow">YOUR COLLECTION</div>
      <div className="page-heading">
        <div>
          <h1>
            My library<span className="gold-text">.</span>
          </h1>
          <p>Old favorites. New beginnings. All yours.</p>
        </div>
        {data.user && (
          <button className="button outline" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? <Loader2 size={17} className="spin" /> : <Upload size={17} />}Import EPUB
          </button>
        )}
        <input
          type="file"
          accept=".epub,application/epub+zip"
          hidden
          ref={input}
          onChange={(e) => upload(e.target.files?.[0])}
        />
      </div>
      <AccountGuard>
        <div className="library-stats">
          <div>
            <strong>{pages.items.length}</strong>
            <span>Books loaded</span>
          </div>
          <div>
            <strong>{data.library.filter((x) => x.status === "reading").length}</strong>
            <span>{tr("library.current", "Currently reading")}</span>
          </div>
          <div>
            <strong>{data.library.filter((x) => x.status === "finished").length}</strong>
            <span>{tr("library.finished", "Finished")}</span>
          </div>
        </div>
        <div className="collection-toolbar">
          <div className="topic-tabs">
            {[
              ["all", tr("library.all", "All books")],
              ["reading", tr("library.reading", "Reading")],
              ["want-to-read", tr("library.want", "Want to read")],
              ["finished", tr("library.finished", "Finished")],
            ].map(([v, l]) => (
              <button className={filter === v ? "active" : ""} onClick={() => setFilter(v)} key={v}>
                {l}
              </button>
            ))}
          </div>
          <div className="small-search">
            <Search size={17} />
            <input
              aria-label="Search your library"
              placeholder="Search your shelves…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        {books.length ? (
          <div className="library-grid">
            {books.map((e) => (
              <article className="library-card" key={e.bookId}>
                <a href={readPath(e.bookId)}>
                  <BookArt book={e.book} />
                </a>
                <div>
                  <p className="small-label">
                    {e.book.uploaded ? "IMPORTED EPUB" : e.status.replaceAll("-", " ")}
                  </p>
                  <a href={bookPath(e.bookId)}>
                    <h2>{e.book.title}</h2>
                  </a>
                  <p className="muted small">{authorOf(e.book)}</p>
                  {e.progress > 0 && (
                    <div className="library-progress">
                      <Progress value={e.progress * 100} />
                      <span>{Math.round(e.progress * 100)}%</span>
                    </div>
                  )}
                  <a href={readPath(e.bookId)} className="text-link">
                    {e.cfi ? "Continue reading" : "Start reading"} <ArrowRight size={15} />
                  </a>
                  <div className="library-card-actions">
                    <Select
                      value={e.status}
                      onValueChange={async (status) => {
                        try {
                          await api("/library", "POST", { bookId: e.bookId, status });
                          await reload();
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      <SelectTrigger aria-label={"Reading status for " + e.book.title}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="want-to-read">Want to read</SelectItem>
                        <SelectItem value="reading">Reading</SelectItem>
                        <SelectItem value="finished">Finished</SelectItem>
                      </SelectContent>
                    </Select>
                    <button
                      className="icon-button muted"
                      aria-label={"Remove " + e.book.title + " from library"}
                      onClick={() => setRemove(e.bookId)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <AddToShelf bookId={e.bookId} />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <BookOpen />
            <h2>{q ? "Nothing on this shelf yet." : "Your next chapter starts here."}</h2>
            <p>Find something in the bookstore or import an EPUB you already own.</p>
            <a className="button gold" href="/">
              {tr("library.browse", "Browse the bookstore")} <ArrowUpRight size={17} />
            </a>
          </div>
        )}
      </AccountGuard>
      <CollectionNextPage state={pages} />
      <ConfirmDelete
        open={!!remove}
        setOpen={() => setRemove("")}
        description="Remove this book from your library? Your highlights, notes, and saved definitions will stay in your notebook."
        onConfirm={async () => {
          await api("/library/" + remove, "DELETE", {});
          await reload();
          setRemove("");
        }}
      />
    </>
  );
}
function ConfirmDelete({
  open,
  setOpen,
  onConfirm,
  description,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  onConfirm: () => Promise<void>;
  description: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent className="fore-dialog">
        <AlertDialogTitle>Remove this item?</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm().catch((err) => toast.error(err.message));
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
function highlightAudienceName(share: HighlightShareAudience) {
  if (share.visibility === "member") return `@${share.recipient?.username || "selected member"}`;
  if (share.visibility === "group") return share.groupName || "reading group";
  return {
    public: "the public",
    followers: "your followers",
    friends: "friends / mutuals",
  }[share.visibility];
}
export function HighlightsPage() {
  const { t: tr } = useStorefrontLocale();
  const { data, reload } = useAccount();
  const [q, setQ] = useState(""),
    [color, setColor] = useState("all"),
    [tab, setTab] = useState("all"),
    [edit, setEdit] = useState<Annotation | null>(null),
    [note, setNote] = useState(""),
    [editColor, setEditColor] = useState("yellow"),
    [remove, setRemove] = useState(""),
    [saving, setSaving] = useState(false),
    [republishing, setRepublishing] = useState(false),
    [republish, setRepublish] = useState<{
      annotationId: string;
      annotationVersion: number;
      note: string;
      shares: HighlightShareAudience[];
      selectedIds: string[];
    } | null>(null);
  const sharing = useQuery<HighlightShareState>({
    queryKey: ["highlight-sharing-editor", data.user?.id, edit?.id],
    queryFn: () => api(`/social/highlights/${encodeURIComponent(edit!.id)}/share`),
    enabled: !!data.user && !!edit,
    staleTime: 0,
  });
  const pages = usePagedAccountCollection<Annotation>(
    "annotations",
    data.annotations,
    data.user?.id,
    q,
  );
  const rows = pages.items.filter(
    (a) =>
      (tab !== "notes" || a.note) &&
      (color === "all" || a.color === color) &&
      [a.quote, a.note, a.bookTitle, a.chapter].join(" ").toLowerCase().includes(q.toLowerCase()),
  );
  async function republishPublishedNote() {
    if (!republish || republishing || !republish.selectedIds.length) return;
    setRepublishing(true);
    try {
      await api(
        `/social/highlights/${encodeURIComponent(republish.annotationId)}/republish-note`,
        "POST",
        {
          confirmed: true,
          expectedAnnotationVersion: republish.annotationVersion,
          shares: republish.shares
            .filter((share) => republish.selectedIds.includes(share.id))
            .map((share) => ({ id: share.id, version: share.version })),
        },
      );
      toast.success(
        `Published note updated for ${republish.selectedIds.length} ${republish.selectedIds.length === 1 ? "audience" : "audiences"}.`,
      );
      setRepublish(null);
    } catch (e) {
      if (e instanceof CoveRequestError && e.status === 409) {
        setRepublish(null);
        setEdit(null);
        await reload();
      }
      toast.error((e as Error).message);
    } finally {
      setRepublishing(false);
    }
  }
  function exportNotes() {
    const text = rows
      .map(
        (a) =>
          `## ${a.bookTitle}\n${a.chapter}\n\n> ${a.quote.replaceAll("\n", "\n> ")}\n\n${a.note || ""}\n\n[Return to passage](${location.origin + readPath(a.bookId, a.cfi)})\n`,
      )
      .join("\n---\n\n");
    downloadBlob(
      new Blob(["# Cove — Highlights & notes\n\n" + text], { type: "text/markdown" }),
      "fore-highlights.md",
    );
  }
  return (
    <>
      <div className="page-eyebrow">YOUR COMMONPLACE BOOK</div>
      <div className="page-heading">
        <div>
          <h1>
            Words worth keeping<span className="gold-text">.</span>
          </h1>
          <p>Return to the lines that made you pause.</p>
        </div>
        {pages.items.length > 0 && (
          <button className="button outline" onClick={exportNotes}>
            <Download size={17} />
            Export notes
          </button>
        )}
      </div>
      <AccountGuard>
        <Tabs value={tab} onValueChange={setTab}>
          <div className="collection-toolbar">
            <TabsList className="fore-tabs">
              <TabsTrigger value="all">
                All highlights <span>{pages.items.length}</span>
              </TabsTrigger>
              <TabsTrigger value="notes">
                With notes <span>{pages.items.filter((x) => x.note).length}</span>
              </TabsTrigger>
            </TabsList>
            <div className="small-search">
              <Search size={17} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search highlights and notes"
                placeholder="Search your passages…"
              />
            </div>
          </div>
          <div className="notebook-filters">
            <span className="small muted">Highlight color</span>
            <button
              className={"color-all " + (color === "all" ? "selected" : "")}
              onClick={() => setColor("all")}
            >
              All
            </button>
            {Object.entries(colors).map(([c, v]) => (
              <button
                className={"color-dot " + (color === c ? "selected" : "")}
                aria-label={"Filter " + c + " highlights"}
                title={c}
                onClick={() => setColor(c)}
                style={{ background: v }}
                key={c}
              />
            ))}
          </div>
          {rows.length ? (
            <div className="annotation-grid">
              {rows.map((a) => (
                <article
                  className="annotation-card"
                  key={a.id}
                  style={{ "--highlight-color": colors[a.color] } as any}
                >
                  <div className="annotation-book">
                    <BookOpen size={15} />
                    <a href={bookPath(a.bookId)}>{a.bookTitle}</a>
                  </div>
                  <blockquote>{a.quote}</blockquote>
                  {a.note && (
                    <div className="annotation-note">
                      <Pencil size={15} />
                      <p>{a.note}</p>
                    </div>
                  )}
                  <div className="annotation-bottom">
                    <a className="text-link" href={readPath(a.bookId, a.cfi)}>
                      Return to passage <ArrowUpRight size={14} />
                    </a>
                    <div>
                      <button
                        className="icon-button"
                        aria-label="Edit highlight note"
                        onClick={() => {
                          setEdit(a);
                          setNote(a.note);
                          setEditColor(a.color);
                        }}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Delete highlight"
                        onClick={() => setRemove(a.id)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                  <span className="annotation-date">
                    {a.chapter || "Saved passage"} ·{" "}
                    {new Date(a.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <Highlighter />
              <h2>
                {pages.items.length ? "No matching passages." : "Some lines deserve a second life."}
              </h2>
              <p>
                While reading, select a passage to highlight it or add a note. You’ll find every
                saved thought here.
              </p>
              <a href="/library" className="button gold">
                Open your library <ArrowRight size={17} />
              </a>
            </div>
          )}
        </Tabs>
      </AccountGuard>
      <Dialog
        open={!!edit}
        onOpenChange={(v) => {
          if (!v) setEdit(null);
        }}
      >
        <DialogContent className="fore-dialog">
          <DialogTitle>Your note</DialogTitle>
          <DialogDescription>{edit?.bookTitle}</DialogDescription>
          <blockquote className="editor-quote">{edit?.quote}</blockquote>
          {sharing.isPending && (
            <p className="small muted" role="status">
              Checking current sharing permissions…
            </p>
          )}
          {sharing.isError && (
            <div role="alert">
              <p>
                Current sharing permissions could not be checked. Retry before saving this note.
              </p>
              <button className="button outline" onClick={() => sharing.refetch()}>
                Retry sharing status
              </button>
            </div>
          )}
          {sharing.data?.shares.length ? (
            <div className="reader-format-notice" role="status">
              <strong>This highlight remains shared</strong>
              <p>Active audiences: {sharing.data.shares.map(highlightAudienceName).join(", ")}.</p>
              <p>
                {sharing.data.shares.some((share) => share.shareNote)
                  ? "For audiences that include your note, Cove keeps a separate published copy. Editing here changes only your private note until you explicitly republish it."
                  : "Your note is not included in these shares. Editing it here will not change what other readers see."}
              </p>
              {sharing.data.shares.some((share) => share.shareNote) && (
                <button
                  className="button outline"
                  disabled={
                    republishing || saving || sharing.isFetching || note !== (edit?.note || "")
                  }
                  onClick={() =>
                    setRepublish({
                      annotationId: edit!.id,
                      annotationVersion: edit!.version,
                      note: edit!.note || "",
                      shares: sharing.data!.shares.filter((share) => share.shareNote),
                      selectedIds: sharing
                        .data!.shares.filter((share) => share.shareNote)
                        .map((share) => share.id),
                    })
                  }
                >
                  Review & republish note…
                </button>
              )}
            </div>
          ) : null}
          <div className="color-options">
            {Object.entries(colors).map(([c, v]) => (
              <button
                key={c}
                onClick={() => setEditColor(c)}
                className={"color-dot " + (editColor === c ? "selected" : "")}
                style={{ background: v }}
                aria-label={c}
              />
            ))}
          </div>
          <textarea
            aria-label="Note on this passage"
            className="note-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={12000}
            placeholder="What does this passage bring to mind?"
          />
          <button
            disabled={saving || sharing.isPending || sharing.isFetching}
            className="button gold"
            onClick={async () => {
              if (!edit || !data.user) return;
              const noteChanged = note !== edit.note,
                publishedShares = (sharing.data?.shares || []).filter((share) => share.shareNote);
              setSaving(true);
              try {
                const written = await queueReaderMutation(
                  data.user.id,
                  "annotation-edit",
                  edit.id,
                  "/annotations/" + edit.id,
                  "PATCH",
                  { note, color: editColor, expectedVersion: edit.version },
                );
                if (!written.queued) await reload();
                setEdit(null);
                if (written.queued) {
                  toast.message("Note saved on this device; it will sync when online.");
                } else if (noteChanged && publishedShares.length) {
                  const saved = written.response as { version: number };
                  setRepublish({
                    annotationId: edit.id,
                    annotationVersion: saved.version,
                    note,
                    shares: publishedShares,
                    selectedIds: publishedShares.map((share) => share.id),
                  });
                  toast.success("Private note saved. Published copies have not changed.");
                } else {
                  toast.success("Your note is saved");
                }
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Save note"}
          </button>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!republish}
        onOpenChange={(open) => {
          if (!open && !republishing) setRepublish(null);
        }}
      >
        <AlertDialogContent className="fore-dialog">
          <AlertDialogTitle>Republish your note?</AlertDialogTitle>
          <AlertDialogDescription>
            Your private note is saved. Existing shares still show the previous published copy.
            Confirm to replace that copy for the selected audiences with your current note.
          </AlertDialogDescription>
          {republish && (
            <ul>
              {republish.shares.map((share) => (
                <li key={share.id}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={republish.selectedIds.includes(share.id)}
                      disabled={republishing}
                      onChange={(e) =>
                        setRepublish({
                          ...republish,
                          selectedIds: e.target.checked
                            ? [...republish.selectedIds, share.id]
                            : republish.selectedIds.filter((id) => id !== share.id),
                        })
                      }
                    />
                    {highlightAudienceName(share)}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {republish && (
            <div className="reader-format-notice">
              <strong>Note copy to publish</strong>
              <blockquote>{republish.note || "No note text"}</blockquote>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={republishing}>
              Keep published copies unchanged
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={republishing || !republish?.selectedIds.length}
              onClick={(e) => {
                e.preventDefault();
                void republishPublishedNote();
              }}
            >
              {republishing ? "Publishing…" : "Republish note"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CollectionNextPage state={pages} />
      <ConfirmDelete
        open={!!remove}
        setOpen={() => setRemove("")}
        description="This removes the highlight and its note from your notebook."
        onConfirm={async () => {
          const target = pages.items.find((a) => a.id === remove);
          if (!target) return setRemove("");
          await api("/annotations/" + remove, "DELETE", { expectedVersion: target.version });
          await reload();
          setRemove("");
        }}
      />
    </>
  );
}
export function DictionaryLookup({
  initialWord = "",
  bookId = "",
  bookTitle = "",
  cfi = "",
  context = "",
  onSaved,
}: {
  initialWord?: string;
  bookId?: string;
  bookTitle?: string;
  cfi?: string;
  context?: string;
  onSaved?: () => void;
}) {
  const { data, reload, signIn } = useAccount();
  const [word, setWord] = useState(initialWord),
    [result, setResult] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  async function lookup(e?: React.FormEvent) {
    e?.preventDefault();
    if (!word.trim()) return;
    setBusy(true);
    setError("");
    setResult([]);
    try {
      setResult(await api("/dictionary?word=" + encodeURIComponent(word.trim())));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dictionary-lookup">
      <form onSubmit={lookup} className="dictionary-form">
        <input
          aria-label="Word to look up"
          value={word}
          onChange={(e) => setWord(e.target.value)}
          placeholder="Look up an English word…"
          maxLength={80}
        />
        <button className="button gold" disabled={busy || !word.trim()}>
          {busy ? <Loader2 size={17} className="spin" /> : <Search size={17} />} Look up
        </button>
      </form>
      {error && <p className="notice">{error}</p>}
      {result[0] && (
        <div className="dictionary-result">
          <div className="word-heading">
            <h2>{result[0].word}</h2>
            <span>{result[0].phonetic}</span>
            {result[0].phonetics?.find((p: any) => p.audio?.startsWith("https://")) && (
              <button
                className="icon-button"
                aria-label="Play pronunciation"
                onClick={() => {
                  const audio = result[0].phonetics.find((p: any) =>
                    p.audio?.startsWith("https://"),
                  ).audio;
                  new Audio(audio)
                    .play()
                    .catch(() => toast.error("Pronunciation audio is unavailable."));
                }}
              >
                <Volume2 size={19} />
              </button>
            )}
          </div>
          {result[0].meanings?.slice(0, 4).map((m: any, i: number) => (
            <div className="word-meaning" key={i}>
              <span>{m.partOfSpeech}</span>
              {m.definitions?.slice(0, 3).map((d: any, j: number) => (
                <div key={j}>
                  <p>{d.definition}</p>
                  {d.example && <em>“{d.example}”</em>}
                  <button
                    disabled={saving}
                    className="text-link"
                    onClick={async () => {
                      if (!data.user) return signIn();
                      setSaving(true);
                      try {
                        await api("/definitions", "POST", {
                          word: result[0].word,
                          phonetic: result[0].phonetic || "",
                          meaning: d.definition,
                          partOfSpeech: m.partOfSpeech,
                          bookId,
                          cfi,
                          context,
                          source: "https://dictionaryapi.dev/",
                        });
                        await reload();
                        toast.success("Added to your word collection");
                        onSaved?.();
                      } catch (e) {
                        toast.error((e as Error).message);
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    <Plus size={14} /> Save this definition
                  </button>
                </div>
              ))}
            </div>
          ))}
          <a
            className="dictionary-credit"
            href="https://dictionaryapi.dev/"
            target="_blank"
            rel="noreferrer"
          >
            Definitions by Free Dictionary API <ArrowUpRight size={12} />
          </a>
        </div>
      )}
      {!result.length && !error && (
        <p className="small muted lookup-hint">
          English definitions, pronunciation, and usage. Save a meaning to make it part of your
          vocabulary.
        </p>
      )}
    </div>
  );
}
export function DefinitionsPage() {
  const { t: tr } = useStorefrontLocale();
  const { data, reload } = useAccount();
  const [q, setQ] = useState(""),
    [remove, setRemove] = useState("");
  const pages = usePagedAccountCollection<Definition>(
    "definitions",
    data.definitions,
    data.user?.id,
    q,
  );
  const rows = pages.items.filter((d) =>
    [d.word, d.meaning, d.bookTitle].join(" ").toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <div className="page-eyebrow">A GROWING VOCABULARY</div>
      <div className="page-heading">
        <div>
          <h1>
            Your word collection<span className="gold-text">.</span>
          </h1>
          <p>Meet a new word. Keep it for a lifetime.</p>
        </div>
      </div>
      <section className="dictionary-panel">
        <DictionaryLookup />
      </section>
      <AccountGuard>
        <div className="collection-toolbar">
          <h2 className="section-title">
            {tr("definitions.saved", "Saved definitions")}{" "}
            <span className="muted">{pages.items.length}</span>
          </h2>
          <div className="small-search">
            <Search size={17} />
            <input
              aria-label="Search saved words"
              placeholder="Find a word…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        {rows.length ? (
          <div className="definition-grid">
            {rows.map((d) => (
              <article className="definition-card" key={d.id}>
                <div className="word-heading">
                  <h2>{d.word}</h2>
                  <button
                    className="icon-button"
                    aria-label={"Delete definition of " + d.word}
                    onClick={() => setRemove(d.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <p className="phonetic">
                  {d.phonetic} <span>{d.partOfSpeech}</span>
                </p>
                <p className="saved-meaning">{d.meaning}</p>
                {d.context && <blockquote>{d.context}</blockquote>}
                {d.bookId && (
                  <a className="text-link" href={readPath(d.bookId, d.cfi)}>
                    <BookOpen size={14} />
                    {d.bookTitle}
                    <ArrowUpRight size={13} />
                  </a>
                )}
                <span className="annotation-date">
                  Saved {new Date(d.createdAt).toLocaleDateString()}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <BookA />
            <h2>{q ? "No matching words." : "A collection, one word at a time."}</h2>
            <p>Look up a word above, or select one while reading. Save the definition that fits.</p>
          </div>
        )}
      </AccountGuard>
      <CollectionNextPage state={pages} />
      <ConfirmDelete
        open={!!remove}
        setOpen={() => setRemove("")}
        description="Remove this definition from your word collection?"
        onConfirm={async () => {
          await api("/definitions/" + remove, "DELETE", {});
          await reload();
          setRemove("");
        }}
      />
    </>
  );
}
export function DownloadsPage() {
  const { data } = useAccount();
  const [busy, setBusy] = useState("");
  return (
    <>
      <div className="page-eyebrow">YOUR LIBRARY, ANYWHERE</div>
      <div className="page-heading">
        <div>
          <h1>
            Take the stories with you<span className="gold-text">.</span>
          </h1>
          <p>Download an EPUB, or bring your whole reading context along.</p>
        </div>
      </div>
      <div className="download-explainer download-explainer-three">
        <div>
          <FileDown size={25} />
          <h2>Download book</h2>
          <p>
            The entitled EPUB only. It never includes your highlights, notes, vocabulary, positions,
            or reading history.
          </p>
        </div>
        <div>
          <Download size={25} />
          <h2>Export reading data</h2>
          <p>
            A private ZIP containing your annotations, saved words, reading position, completion
            history, and reading sessions. It contains no ebook.
          </p>
        </div>
        <div className="private-backup-option">
          <ShieldCheck size={25} />
          <h2>Cove backup package</h2>
          <p>
            <strong>Private archive:</strong> combines both the EPUB and your reading data. Review
            it before sharing or transferring it to another person.
          </p>
          <span className="small muted">Cove private backup v2 · ebook + personal data</span>
        </div>
      </div>
      <OfflineDownloads />
      <AccountGuard>
        {data.library.length ? (
          <div className="download-list">
            {data.library.map((e) => (
              <div className="download-item" key={e.bookId}>
                <BookArt book={e.book} />
                <div>
                  <a href={bookPath(e.bookId)}>
                    <h2>{e.book.title}</h2>
                  </a>
                  <p>{authorOf(e.book)}</p>
                </div>
                <div className="download-buttons">
                  {(["book", "data", "backup"] as const).map((kind) => {
                    const contentExport = kind !== "data";
                    if (contentExport && e.book.downloadable === false)
                      return (
                        <span className="export-unavailable" key={kind}>
                          {kind === "book" ? "Book download" : "Private backup"}: Cove reader only
                        </span>
                      );
                    return (
                      <button
                        className="button outline"
                        disabled={!!busy}
                        onClick={async () => {
                          if (
                            kind === "backup" &&
                            !window.confirm(
                              "Create a private Cove backup? This ZIP includes the ebook together with your highlights, notes, vocabulary, reading positions, and reading history. Do not share it as if it were only a book file.",
                            )
                          )
                            return;
                          setBusy(e.bookId + kind);
                          try {
                            if (kind === "book") await downloadBook(e.book);
                            else if (kind === "data") await exportReadingData(e.book);
                            else await downloadCoveBackup(e.book);
                            toast.success(
                              kind === "book"
                                ? "Book downloaded"
                                : kind === "data"
                                  ? "Reading data exported"
                                  : "Private backup created",
                            );
                          } catch (e) {
                            toast.error((e as Error).message);
                          } finally {
                            setBusy("");
                          }
                        }}
                        key={kind}
                      >
                        {busy === e.bookId + kind ? (
                          <Loader2 className="spin" size={16} />
                        ) : kind === "backup" ? (
                          <ShieldCheck size={16} />
                        ) : kind === "data" ? (
                          <FileDown size={16} />
                        ) : (
                          <Download size={16} />
                        )}{" "}
                        {kind === "book"
                          ? "Download book"
                          : kind === "data"
                            ? "Export reading data"
                            : "Private backup"}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Download />
            <h2>Build a library to take with you.</h2>
            <p>Add books from the bookstore. Your downloads will be ready here.</p>
            <a href="/" className="button gold">
              Explore books
            </a>
          </div>
        )}
      </AccountGuard>
    </>
  );
}
export function ProfilePage() {
  const { data, reload } = useAccount();
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false);
  const [recSettings, setRecSettings] = useState<{
    personalizationEnabled: boolean;
    activityPersonalizationEnabled: boolean;
    personalizedSearchEnabled: boolean;
  } | null>(null);
  const [recBusy, setRecBusy] = useState(false);
  useEffect(() => {
    if (!data.user) return;
    let cancelled = false;
    api<any>("/recommendations/account")
      .then((x) => {
        if (!cancelled) setRecSettings(x.privacy);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [data.user?.id]);
  async function saveRecommendationSettings(next: typeof recSettings) {
    if (!next) return;
    setRecBusy(true);
    try {
      const saved = await api<any>("/recommendations/privacy", "POST", next);
      setRecSettings(saved);
      toast.success("Recommendation preferences saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRecBusy(false);
    }
  }
  return (
    <>
      <div className="page-eyebrow">YOUR READING ROOM</div>
      <div className="page-heading">
        <div>
          <h1>
            {data.user?.registered ? "Your account" : "Make it yours"}
            <span className="gold-text">.</span>
          </h1>
          <p>A small home for a lifetime of reading.</p>
        </div>
      </div>
      <AccountGuard>
        <div className="profile-panel">
          <span className="profile-avatar">{(data.user?.name || "R")[0].toUpperCase()}</span>
          <h2>{data.user?.registered ? data.user.name : "Welcome to Cove"}</h2>
          <p className="muted">{data.user?.email}</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api("/profile", "POST", { name: name.trim() || data.user?.name });
                await reload();
                toast.success("Your reading profile is saved");
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label htmlFor="profile-name">What should we call you?</label>
            <input
              id="profile-name"
              value={name}
              placeholder={data.user?.name || "Your name"}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required={!data.user?.name}
            />
            <button disabled={busy} className="button gold">
              {busy
                ? "Saving…"
                : data.user?.registered
                  ? "Save profile"
                  : "Create my reading profile"}
            </button>
          </form>
          {!data.user?.username && (
            <form
              className="fore-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                try {
                  await api("/auth/username", "POST", { username: form.get("username") });
                  await reload();
                  toast.success("Username saved");
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              <label>
                Choose your username
                <input
                  name="username"
                  required
                  pattern="[a-zA-Z][a-zA-Z0-9_]{2,29}"
                  minLength={3}
                  maxLength={30}
                  autoComplete="username"
                  placeholder="Your unique reading name"
                />
              </label>
              <button className="button outline">Save username</button>
            </form>
          )}
          <div className="profile-info">
            <Check size={18} />
            <p>
              Your email is verified. Your books, notes, and definitions are saved to your Cove
              account.
            </p>
          </div>
          <section className="recommendation-privacy-panel">
            <div>
              <span className="small-label">PERSONALIZATION & PRIVACY</span>
              <h3>Recommendation controls</h3>
              <p className="muted">
                Cove can use your reading, ratings, wishlist, follows, and recommendation
                interactions to personalize discovery. Turning this off does not affect your library
                or reading history.
              </p>
            </div>
            {recSettings ? (
              <div className="recommendation-privacy-controls">
                <label>
                  <input
                    type="checkbox"
                    checked={recSettings.personalizationEnabled}
                    onChange={(e) =>
                      setRecSettings({ ...recSettings, personalizationEnabled: e.target.checked })
                    }
                  />{" "}
                  Personalized recommendations
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={recSettings.activityPersonalizationEnabled}
                    onChange={(e) =>
                      setRecSettings({
                        ...recSettings,
                        activityPersonalizationEnabled: e.target.checked,
                      })
                    }
                  />{" "}
                  Learn from my reading activity
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={recSettings.personalizedSearchEnabled}
                    onChange={(e) =>
                      setRecSettings({
                        ...recSettings,
                        personalizedSearchEnabled: e.target.checked,
                      })
                    }
                  />{" "}
                  Personalize search ranking
                </label>
                <div className="recommendation-privacy-actions">
                  <button
                    className="button outline"
                    disabled={recBusy}
                    onClick={() => saveRecommendationSettings(recSettings)}
                  >
                    {recBusy ? "Saving…" : "Save recommendation settings"}
                  </button>
                  <button
                    className="text-link"
                    disabled={recBusy}
                    onClick={async () => {
                      if (
                        !confirm(
                          "Reset Cove's learned recommendation profile? Your library, ratings, wishlist, and author follows will remain.",
                        )
                      )
                        return;
                      setRecBusy(true);
                      try {
                        await api("/recommendations/reset", "POST", { scope: "learned" });
                        toast.success("Learned recommendation profile reset");
                      } catch (e) {
                        toast.error((e as Error).message);
                      } finally {
                        setRecBusy(false);
                      }
                    }}
                  >
                    Reset learned profile
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted">Loading recommendation preferences…</p>
            )}
          </section>
          <AccountManagementPanel />
          <button
            className="button outline"
            onClick={() =>
              downloadBlob(
                new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
                "fore-reading-data.json",
              )
            }
          >
            <Download size={16} />
            Export my reading data
          </button>
          <button
            className="text-link signout"
            onClick={async () => {
              await api("/auth/logout", "POST", {});
              location.assign("/");
            }}
          >
            <LogOut size={16} />
            Log out
          </button>
        </div>
      </AccountGuard>
    </>
  );
}
