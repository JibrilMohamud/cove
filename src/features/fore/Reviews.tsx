import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Heart, Star, Lock, Globe, Flag, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Switch } from "@/components/ui/switch";
import { api, useAccount } from "./client";
import { RATINGS, RATING_LABELS, type Review } from "./domain";

function provenanceLabel(review: Review) {
  switch (review.provenance?.type) {
    case "verified_purchase": return "Verified purchase";
    case "subscription_reader": return "Subscription reader";
    case "free_promotional_copy": return "Promotional copy";
    case "gifted": return "Gifted copy";
    case "publisher_author_copy": return "Publisher/author copy";
    default: return "Access not verified";
  }
}

export function Stars({ rating }: { rating: number }) {
  return (
    <span className="stars-display" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className="star-cell">
          <Star size={17} />
          <span style={{ width: `${Math.max(0, Math.min(1, rating - n + 1)) * 100}%` }}>
            <Star size={17} fill="currentColor" />
          </span>
        </span>
      ))}
    </span>
  );
}
type ReviewResult = {
  reviews: Review[];
  mine: Review | null;
  count: number;
  page: number;
  pages: number;
  summary: {
    count: number;
    average: number | null;
    distribution: { rating: number; count: number }[];
  };
};
export function Reviews({ bookId, personal = false }: { bookId: string; personal?: boolean }) {
  const { data, signIn } = useAccount();
  const [sort, setSort] = useState("popular"),
    [filter, setFilter] = useState("all"),
    [textOnly, setTextOnly] = useState(false),
    [page, setPage] = useState(1);
  const result = useQuery<ReviewResult>({
    queryKey: ["reviews", bookId, data.user?.id, sort, filter, textOnly, page],
    queryFn: () =>
      api(
        `/books/${bookId}/reviews?` +
          new URLSearchParams({
            sort,
            ...(filter === "all" ? {} : { rating: filter }),
            textOnly: String(textOnly),
            page: String(page),
          }),
      ),
  });
  const [rating, setRating] = useState<number | null>(null),
    [body, setBody] = useState(""),
    [visibility, setVisibility] = useState("private"),
    [spoiler, setSpoiler] = useState(false),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState(false),
    [report, setReport] = useState(""),
    [reason, setReason] = useState("spam"),
    [reaction, setReaction] = useState("");
  const mine = result.data?.mine;
  useEffect(() => {
    setRating(mine?.rating || null);
    setBody(mine?.body || "");
    setVisibility(mine?.visibility || "private");
    setSpoiler(mine?.spoiler || false);
  }, [mine?.id, mine?.updatedAt]);
  async function save() {
    if (!data.user) return signIn();
    setBusy(true);
    try {
      await api("/books/" + bookId + "/reviews", "PUT", { rating, body, visibility, spoiler });
      await result.refetch();
      toast.success(visibility === "private" ? "Saved privately" : "Your rating is published");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="reviews-section">
      <div className="section-heading">
        <h2>Ratings & reviews</h2>
        <span className="muted">{result.data?.summary.count || 0} public ratings</span>
      </div>
      {result.isLoading ? (
        <p role="status">Loading reviews…</p>
      ) : result.error ? (
        <p className="notice">
          {result.error.message} <button onClick={() => result.refetch()}>Retry</button>
        </p>
      ) : (
        <>
          <div className="review-overview">
            <div>
              <strong>{result.data?.summary.average?.toFixed(2) || "—"}</strong>
              <span>out of 5</span>
              {result.data?.summary.average != null && (
                <Stars rating={result.data.summary.average} />
              )}
            </div>
            <div className="rating-distribution">
              {[...RATINGS].reverse().map((n) => {
                const count =
                  result.data?.summary.distribution.find((d) => d.rating === n)?.count || 0;
                return (
                  <button
                    key={n}
                    title={`Show ${n}-star ratings`}
                    onClick={() => {
                      setFilter(String(n));
                      setPage(1);
                    }}
                  >
                    <span>{n} ★</span>
                    <span className="distribution-track">
                      <span
                        style={{
                          width: `${(count / Math.max(1, result.data?.summary.count || 0)) * 100}%`,
                        }}
                      />
                    </span>
                    <span>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="review-editor">
            <div className="section-heading">
              <h3>{mine ? "Your rating" : "What did you think?"}</h3>
              {mine?.visibility === "private" && (
                <span className="privacy-label">
                  <Lock size={14} /> Only you
                </span>
              )}
            </div>
            <p className="muted small">Choose a half-star rating. A written review is optional.</p>
            <div className="half-star-picker" role="radiogroup" aria-label="Your star rating">
              {RATINGS.map((n) => (
                <button
                  role="radio"
                  aria-checked={rating === n}
                  tabIndex={(rating || 0.5) === n ? 0 : -1}
                  className={rating === n ? "selected" : ""}
                  key={n}
                  onClick={() => setRating(n)}
                  onKeyDown={(event) => {
                    const direction = ["ArrowRight", "ArrowDown"].includes(event.key)
                      ? 1
                      : ["ArrowLeft", "ArrowUp"].includes(event.key)
                        ? -1
                        : 0;
                    if (!direction) return;
                    event.preventDefault();
                    const next =
                      RATINGS[(RATINGS.indexOf(n) + direction + RATINGS.length) % RATINGS.length];
                    setRating(next);
                    const buttons =
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                        '[role="radio"]',
                      );
                    buttons?.[RATINGS.indexOf(next)].focus();
                  }}
                  title={RATING_LABELS[n]}
                  aria-label={`${n} stars: ${RATING_LABELS[n]}`}
                >
                  {n}
                  <Star size={14} fill={rating === n ? "currentColor" : "none"} />
                </button>
              ))}
            </div>
            <p className="rating-caption" aria-live="polite">
              {rating ? RATING_LABELS[rating] : "Select your rating"}
            </p>
            <label htmlFor="review-body">
              Review <span className="muted">(optional)</span>
            </label>
            <textarea
              id="review-body"
              className="note-input"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={20000}
              placeholder="What will stay with you?"
            />
            <div className="review-options">
              <Select value={visibility} onValueChange={setVisibility}>
                <SelectTrigger aria-label="Review visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private · only you</SelectItem>
                  {!personal && <SelectItem value="public">Public · everyone</SelectItem>}
                </SelectContent>
              </Select>
              <label className="switch-label">
                <Switch
                  checked={spoiler}
                  onCheckedChange={setSpoiler}
                  aria-label="Contains spoilers"
                />
                Contains spoilers
              </label>
            </div>
            <p className="small muted">
              {visibility === "private"
                ? "Your rating and review stay out of public averages, feeds, and search."
                : "Your profile name, rating, and review will be visible to everyone who can access Cove."}
            </p>
            <div className="inline-actions">
              <button className="button gold" disabled={busy || rating === null} onClick={save}>
                {busy ? (
                  <Loader2 className="spin" size={16} />
                ) : visibility === "private" ? (
                  <Lock size={16} />
                ) : (
                  <Globe size={16} />
                )}{" "}
                {data.user
                  ? visibility === "private"
                    ? "Save privately"
                    : "Publish rating"
                  : "Sign in to rate"}
              </button>
              {mine && (
                <button className="text-link" onClick={() => setRemove(true)}>
                  <Trash2 size={15} />
                  Delete rating
                </button>
              )}
            </div>
          </div>
          <div className="review-filters">
            <Select
              value={filter}
              onValueChange={(v) => {
                setFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="Filter by star rating">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ratings</SelectItem>
                {RATINGS.map((n) => (
                  <SelectItem value={String(n)} key={n}>
                    {n} stars · {RATING_LABELS[n]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={sort}
              onValueChange={(v) => {
                setSort(v);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="Sort reviews">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="popular">Popular · most hearts</SelectItem>
                <SelectItem value="trending">Trending · hearts this week</SelectItem>
                <SelectItem value="new">Newest</SelectItem>
                <SelectItem value="longest">Word count · longest</SelectItem>
                <SelectItem value="shortest">Word count · shortest</SelectItem>
              </SelectContent>
            </Select>
            <label className="switch-label">
              <Switch
                checked={textOnly}
                onCheckedChange={(v) => {
                  setTextOnly(v);
                  setPage(1);
                }}
              />
              Written reviews only
            </label>
          </div>
          <div className="review-list">
            {result.data?.reviews.map((r) => (
              <article className="review-card" key={r.id}>
                <header>
                  <span className="avatar">{r.name[0]?.toUpperCase()}</span>
                  <div>
                    <strong>
                      {r.name}
                      {r.mine ? " · you" : ""}
                    </strong>
                    <time dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleDateString()}</time>
                    <span className={`review-provenance ${r.provenance?.verified ? "verified" : "unverified"}`} title="Access status is frozen when the review is first submitted.">
                      {provenanceLabel(r)}
                    </span>
                  </div>
                  {r.rating && (
                    <div className="review-score">
                      <Stars rating={r.rating} />
                      <span>
                        {r.rating} · {RATING_LABELS[r.rating]}
                      </span>
                    </div>
                  )}
                </header>
                {r.body ? (
                  r.spoiler ? (
                    <details className="spoiler-review">
                      <summary>Contains spoilers · reveal review</summary>
                      <p>{r.body}</p>
                    </details>
                  ) : (
                    <p className="review-body">{r.body}</p>
                  )
                ) : (
                  <p className="muted small">Rated without a written review.</p>
                )}
                <footer>
                  <button
                    className={"heart-button " + (r.hearted ? "hearted" : "")}
                    aria-label={`${r.hearted ? "Remove heart from" : "Heart"} review by ${r.name}`}
                    aria-pressed={r.hearted}
                    disabled={r.mine || reaction === r.id}
                    onClick={async () => {
                      if (!data.user) return signIn();
                      setReaction(r.id);
                      try {
                        await api("/reviews/" + r.id + "/heart", r.hearted ? "DELETE" : "PUT", {});
                        await result.refetch();
                      } catch (e) {
                        toast.error((e as Error).message);
                      } finally {
                        setReaction("");
                      }
                    }}
                  >
                    <Heart size={17} fill={r.hearted ? "currentColor" : "none"} />
                    {r.hearts}
                  </button>
                  <span className="small muted">{r.wordCount} words</span>
                  {!r.mine && (
                    <button
                      className="text-link muted"
                      aria-label="Report review"
                      onClick={() => {
                        if (!data.user) return signIn();
                        setReport(r.id);
                      }}
                    >
                      <Flag size={14} />
                      Report
                    </button>
                  )}
                </footer>
              </article>
            ))}
          </div>
          {!result.data?.reviews.length && (
            <p className="quiet-empty">No public ratings match these filters.</p>
          )}
          {(result.data?.pages || 0) > 1 && (
            <div className="pagination">
              <button
                className="button outline"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                {page} / {result.data?.pages}
              </span>
              <button
                className="button outline"
                disabled={page === (result.data?.pages || 1)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
      <AlertDialog open={remove} onOpenChange={setRemove}>
        <AlertDialogContent className="fore-dialog">
          <AlertDialogTitle>Delete your rating and review?</AlertDialogTitle>
          <AlertDialogDescription>
            Your library and reading history will stay.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                try {
                  await api("/books/" + bookId + "/reviews", "DELETE", {});
                  await result.refetch();
                  setRating(null);
                  setBody("");
                  setRemove(false);
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={!!report} onOpenChange={(v) => !v && setReport("")}>
        <DialogContent className="fore-dialog">
          <DialogTitle>Report review</DialogTitle>
          <DialogDescription>
            Tell us what needs attention. Reports go to the site operator.
          </DialogDescription>
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger aria-label="Report reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["spam", "harassment", "spoilers", "other"].map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            className="button gold"
            onClick={async () => {
              try {
                await api("/reviews/" + report + "/report", "POST", { reason });
                setReport("");
                toast.success("Report received");
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          >
            Send report
          </button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
