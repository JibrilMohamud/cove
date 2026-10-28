import { tasteControlsSchema, type TasteControls } from "./discovery-engine";
import { useUiText } from "./ui-text";
import { formatMinorCurrency } from "./currency";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStorefrontLocale } from "./localization";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Search,
  ArrowUpRight,
  BookOpen,
  ArrowRight,
  Plus,
  Check,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ChevronDown,
  EyeOff,
} from "lucide-react";
import { toast } from "sonner";
import {
  api,
  authorOf,
  coverOf,
  bookPath,
  productPath,
  editionPath,
  readPath,
  authorPath,
  seriesPath,
  useAccount,
  type CatalogBook,
} from "./client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { StorefrontBootstrap } from "./storefront-bootstrap";
import { verifiedFirstPageShelf } from "./bookstore-first-paint";

export function BookArt({
  book,
  className = "",
  priority = false,
}: {
  book: CatalogBook;
  className?: string;
  priority?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const url = coverOf(book);
  return (
    <div className={"book-art " + className}>
      {url && !broken ? (
        <img
          src={url}
          onError={() => setBroken(true)}
          alt={"Cover of " + book.title}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          width={240}
          height={360}
        />
      ) : (
        <div className="cover-fallback">
          <BookOpen size={34} />
          <span>{book.title}</span>
          <small>{authorOf(book)}</small>
        </div>
      )}
    </div>
  );
}

function AuthorLinks({ book }: { book: CatalogBook }) {
  const authors = book.authors || [];
  if (!authors.length) return <>Unknown author</>;
  return (
    <>
      {authors.map((author, index) => (
        <span key={`${author.id || author.name}:${index}`}>
          {index > 0 ? ", " : ""}
          {author.id ? (
            <a href={authorPath(author)}>{authorOf({ ...book, authors: [author] })}</a>
          ) : (
            authorOf({ ...book, authors: [author] })
          )}
        </span>
      ))}
    </>
  );
}

function priceLabel(book: CatalogBook) {
  const offer = book.offer;
  if (!offer) return "Unavailable";
  if (Number(offer.amountMinor || 0) === 0) return "Free";
  return formatMinorCurrency(Number(offer.amountMinor || 0), offer.currency || "USD");
}

export function BookCard({
  book,
  onOpen,
  priority = false,
}: {
  book: CatalogBook;
  onOpen?: () => void;
  priority?: boolean;
}) {
  const { data, reload, signIn } = useAccount();
  const saved = data.library.some(
    (x) =>
      x.productId === String(book.productId || "") ||
      x.book.publicProductId === book.publicProductId ||
      x.bookId === String(book.sourceExternalId || book.id),
  );
  const freeAccess =
    book.uploaded ||
    book.copyright === false ||
    (!!book.offer && Number(book.offer.amountMinor ?? 0) === 0);
  const [busy, setBusy] = useState(false);
  async function add() {
    if (!data.user) return signIn();
    setBusy(true);
    try {
      await api("/library", "POST", { bookId: String(book.id) });
      await reload();
      toast.success("Added to your library");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="book-card">
      <Link className="cover-link" to={editionPath(book)} onClick={onOpen} preload={false}>
        <BookArt book={book} priority={priority} />
        <span className="cover-open">
          Explore book <ArrowUpRight size={17} />
        </span>
      </Link>
      <div className="book-meta">
        <p className="book-genre">
          {book.series?.[0]?.id ? (
            <a href={seriesPath(book.series[0])}>{book.series[0].name}</a>
          ) : (
            (
              book.bookshelves?.find((s) => s.startsWith("Browsing: ")) ||
              book.bookshelves?.find(
                (s) => !s.startsWith("Browsing") && !/list|best|banned/i.test(s),
              ) ||
              book.subjects?.[0] ||
              "Literature"
            )
              .replace(/^.*?: /, "")
              .split(" -- ")[0]
          )}
        </p>
        <Link to={editionPath(book)} className="book-title" onClick={onOpen} preload={false}>
          {book.title}
        </Link>
        <p className="book-author">
          <AuthorLinks book={book} />
        </p>
        <div className="book-card-bottom">
          <span>
            {priceLabel(book)} <span className="epub-label">EPUB</span>
          </span>
          {(saved || freeAccess) && (
            <button
              className={"icon-button " + (saved ? "is-saved" : "")}
              aria-label={
                saved ? book.title + " is in your library" : "Add " + book.title + " to library"
              }
              disabled={saved || busy}
              onClick={add}
            >
              {busy ? (
                <Loader2 size={17} className="spin" />
              ) : saved ? (
                <Check size={17} />
              ) : (
                <Plus size={19} />
              )}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

type FacetValue = { value: string; count: number };
type TaxonomyNode = {
  id: string;
  slug: string;
  path: string;
  depth: number;
  name: string;
  description: string;
  count: number;
  featured: boolean;
  href: string;
  children: TaxonomyNode[];
};
export type TaxonomyResponse = {
  taxonomy: string;
  version: string;
  countsPending?: boolean;
  featured: TaxonomyNode[];
  nodes: TaxonomyNode[];
};
export type StorefrontPage = {
  path: string;
  pageType: string;
  title?: string;
  noindex?: boolean;
  heading?: string;
  eyebrow?: string;
  description?: string;
  seoTitle?: string;
  seoDescription?: string;
  canonical: string;
  query: Record<string, unknown>;
  redirectTo?: string;
  statusCode?: number;
  taxonomy?: { id: string; path: string; name: string };
  breadcrumbs?: { id: string; name: string; path: string; href: string }[];
  children?: { id: string; name: string; path: string; description: string; href: string }[];
  entity?: {
    id: string;
    type: string;
    name: string;
    bio?: string;
    website?: string;
    description?: string;
    imageUrl?: string;
    publisherId?: string | null;
    publisherSlug?: string | null;
    publisherName?: string;
    seriesType?: string;
    imprints?: { id: string; name: string; slug: string }[];
    series?: { id: string; name: string; slug: string; seriesType?: string }[];
  };
};
type MerchPlacement = {
  id: string;
  campaignId: string;
  slotKey: string;
  type: string;
  sourceType: string;
  title: string;
  eyebrow: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
  imageUrl: string;
  badge: string;
  sponsored: boolean;
  sponsorName: string;
  experimentId: string | null;
  experimentVariant: string | null;
  books: CatalogBook[];
};
type MerchResponse = { visitorId: string; slots: Record<string, MerchPlacement[]> };
type RecommendationRailData = {
  key: string;
  title: string;
  subtitle?: string;
  requestId: string;
  modelVersion: string;
  personalized: boolean;
  books: CatalogBook[];
  items: { productId: string; score: number; reasonCode: string; reason: string }[];
};
type RecommendationResponse = {
  rails: RecommendationRailData[];
  personalization: { enabled: boolean; activityLearning: boolean; personalizedSearch: boolean };
  model: { key: string; version: string; externalScorer?: boolean };
};

function LiteraryDiscoveryPanel({ visitor }: { visitor: string }) {
  const ui = useUiText();
  const { data } = useAccount();
  const [query, setQuery] = useState("");
  const dirty = useRef(false);
  const tasteOwner = useRef(data.user?.id);
  const [likes, setLikes] = useState("");
  const [dislikes, setDislikes] = useState("");
  const [minutes, setMinutes] = useState("");
  const [adventure, setAdventure] = useState(0.3);
  const [response, setResponse] = useState<{
    rails: RecommendationRailData[];
    emptyReason: string | null;
    intent: { unresolved: string[] };
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const saved = useQuery<TasteControls>({
    queryKey: ["discovery-taste", data.user?.id],
    queryFn: () => api("/recommendations/taste"),
    enabled: !!data.user,
  });
  useEffect(() => {
    if (tasteOwner.current !== data.user?.id) {
      dirty.current = false;
      tasteOwner.current = data.user?.id;
    }
    if (dirty.current) return;
    const controls = saved.data;
    setLikes(controls?.likes.join(", ") || "");
    setDislikes(controls?.dislikes.join(", ") || "");
    setMinutes(controls?.maxMinutes?.toString() || "");
    setAdventure(controls?.adventurousness ?? 0.3);
    setResponse(null);
  }, [saved.data, data.user?.id]);
  const controls = () =>
    tasteControlsSchema.parse({
      likes: likes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      dislikes: dislikes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      maxMinutes: minutes ? Number(minutes) : null,
      adventurousness: adventure,
      languages: saved.data?.languages || [],
    });
  return (
    <section className="recommendation-rail" aria-labelledby="literary-discovery-title">
      <h2 id="literary-discovery-title">{ui("What would you love to read next?")}</h2>
      <p>
        {ui(
          "Explore by theme, mood, style or setting. Try “mystery, reflective, under 4 hours”. Results use available book evidence.",
        )}
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          try {
            setResponse(
              await api(
                `/recommendations/discover?visitor=${encodeURIComponent(visitor)}`,
                "POST",
                { query, controls: controls() },
              ),
            );
          } catch {
            setMessage("Discovery is unavailable or a preference is invalid. Please try again.");
          } finally {
            setBusy(false);
          }
        }}
        className="grid gap-3 max-w-3xl my-5"
      >
        <label>
          {ui("For this search")}
          <input
            className="block border rounded p-2 w-full"
            value={query}
            maxLength={500}
            onChange={(e) => {
              dirty.current = true;
              setQuery(e.target.value);
            }}
            placeholder={ui("mystery, reflective, less violence")}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            {ui("More of (comma-separated)")}
            <input
              className="block border rounded p-2 w-full"
              value={likes}
              maxLength={1000}
              onChange={(e) => {
                dirty.current = true;
                setLikes(e.target.value);
              }}
              placeholder={ui("friendship, witty")}
            />
          </label>
          <label>
            {ui("Avoid known themes or styles")}
            <input
              className="block border rounded p-2 w-full"
              value={dislikes}
              maxLength={1000}
              onChange={(e) => {
                dirty.current = true;
                setDislikes(e.target.value);
              }}
              placeholder={ui("war, melancholic")}
            />
          </label>
          <label>
            {ui("Maximum reading time in minutes")}
            <input
              className="block border rounded p-2 w-full"
              type="number"
              min={5}
              max={10000}
              value={minutes}
              onChange={(e) => {
                dirty.current = true;
                setMinutes(e.target.value);
              }}
              placeholder={ui("Any length")}
            />
          </label>
          <label>
            {ui("Discovery adventure: {percent}%", { percent: Math.round(adventure * 100) })}
            <input
              className="block w-full"
              type="range"
              min={0}
              max={1}
              step={0.1}
              aria-valuetext={ui("Discovery adventure: {percent}%", {
                percent: Math.round(adventure * 100),
              })}
              value={adventure}
              onChange={(e) => {
                dirty.current = true;
                setAdventure(Number(e.target.value));
              }}
            />
          </label>
        </div>
        <p className="text-sm">
          {ui(
            "Avoid filters exclude books tagged with those terms; books with incomplete profiles may have unrecorded content. Time limits require a supported estimate.",
          )}
        </p>
        <div className="flex gap-4 flex-wrap">
          <button className="border rounded px-4 py-2" disabled={busy || !visitor} type="submit">
            {busy ? ui("Finding books…") : ui("Discover books")}
          </button>
          {data.user && (
            <button
              className="border rounded px-4 py-2"
              type="button"
              onClick={async () => {
                try {
                  await api("/recommendations/taste", "POST", controls());
                  setMessage(
                    "Taste preferences saved. Search wording applies only to this search.",
                  );
                } catch {
                  setMessage("Could not save these preferences. Check the values and try again.");
                }
              }}
            >
              {ui("Save taste preferences")}
            </button>
          )}
          <button
            className="border rounded px-4 py-2"
            type="button"
            onClick={() => {
              dirty.current = true;
              setLikes("");
              setDislikes("");
              setMinutes("");
              setQuery("");
              setAdventure(0.3);
              setResponse(null);
              setMessage("Form cleared. Save to replace your saved preferences.");
            }}
          >
            {ui("Clear preferences")}
          </button>
        </div>
      </form>
      <p role="status" aria-live="polite">
        {ui(message || response?.emptyReason || "")}
      </p>
      {!!response?.intent.unresolved.length && (
        <p>
          {ui("Could not interpret: {terms}. Try individual themes or “under 4 hours”.", {
            terms: response.intent.unresolved.join(", "),
          })}
        </p>
      )}
      {response?.rails.map((rail) => (
        <RecommendationRailView key={rail.requestId} rail={rail} visitor={visitor} />
      ))}
    </section>
  );
}

function RecommendationCard({
  rail,
  book,
  position,
  visitor,
}: {
  rail: RecommendationRailData;
  book: CatalogBook;
  position: number;
  visitor: string;
}) {
  const { data } = useAccount();
  const ref = useRef<HTMLDivElement | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const node = ref.current,
      productId = book.productId;
    if (!node || !productId || !visitor) return;
    let sent = false;
    const fire = () => {
      if (sent) return;
      sent = true;
      void api("/recommendations/event", "POST", {
        type: "recommendation_impression",
        productId,
        visitorId: visitor,
        requestId: rail.requestId,
        position,
        surface: `home:${rail.key}`,
      }).catch(() => {});
    };
    if (!("IntersectionObserver" in window)) {
      fire();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)) {
          fire();
          observer.disconnect();
        }
      },
      { threshold: [0.5] },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rail.requestId, rail.key, book.productId, position, visitor]);
  if (hidden) return null;
  const reason = rail.items.find((x) => x.productId === book.productId)?.reason;
  return (
    <div className="recommendation-card-wrap" ref={ref}>
      <BookCard
        book={book}
        onOpen={() => {
          if (book.productId)
            void api("/recommendations/event", "POST", {
              type: "recommendation_click",
              productId: book.productId,
              visitorId: visitor,
              requestId: rail.requestId,
              position,
              surface: `home:${rail.key}`,
            }).catch(() => {});
        }}
      />
      {reason && <p className="recommendation-reason">{reason}</p>}
      {data.user && book.productId && (
        <button
          className="recommendation-hide"
          onClick={async () => {
            try {
              await api("/recommendations/event", "POST", {
                type: "loved",
                requestId: rail.requestId,
                productId: book.productId,
                eventId: crypto.randomUUID(),
                visitorId: visitor,
                surface: "discovery-feedback",
              });
              toast.success("Your feedback will help shape your recommendations.");
            } catch {
              toast.error("Could not save feedback. Please try again.");
            }
          }}
          aria-label={`I loved ${book.title}`}
        >
          I loved this
        </button>
      )}
      {data.user && book.productId && (
        <button
          className="recommendation-hide"
          onClick={async () => {
            setHidden(true);
            try {
              await api("/recommendations/feedback", "POST", {
                entityType: "product",
                entityId: book.productId,
                action: "not_interested",
                reason: "home rail",
              });
            } catch {
              setHidden(false);
            }
          }}
        >
          <EyeOff size={13} /> Not interested
        </button>
      )}
    </div>
  );
}
function RecommendationRailView({
  rail,
  visitor,
}: {
  rail: RecommendationRailData;
  visitor: string;
}) {
  if (!rail.books.length) return null;
  return (
    <section className="recommendation-rail">
      <div className="merch-rail-heading">
        <div>
          <span className="small-label">
            {rail.personalized ? "PERSONALIZED FOR YOU" : "FORE DISCOVERY"}
          </span>
          <h2>{rail.title}</h2>
          {rail.subtitle && <p>{rail.subtitle}</p>}
        </div>
      </div>
      <div className="book-grid merch-grid">
        {rail.books.map((book, index) => (
          <RecommendationCard
            key={String(book.productId || book.id)}
            rail={rail}
            book={book}
            position={index + 1}
            visitor={visitor}
          />
        ))}
      </div>
    </section>
  );
}

export type CatalogResponse = {
  results: CatalogBook[];
  count: number;
  next: string | null;
  cached?: boolean;
  /** First-paint books are current; the full result count/facets load after hydration. */
  preview?: boolean;
  warning?: string;
  ingestion?: { status: string; cachedBooks: number; totalCatalogCount: number };
  facets?: {
    categories: FacetValue[];
    languages: FacetValue[];
    formats: FacetValue[];
    publishers: FacetValue[];
    series: FacetValue[];
    availability: FacetValue[];
    price: { currency: string; min: number; max: number } | null;
  };
  search?: {
    queryId: string | null;
    backend: string;
    processingTimeMs: number;
    correctedQuery?: string | null;
    pageSize?: number;
  };
};

function useUrlSearch(landingPath: string) {
  // Router state is available during SSR, so bookmarked/search-engine requests render with
  // their URL filters immediately instead of waiting for a client-only window.location read.
  const routerSearchString = useRouterState({ select: (state) => state.location.searchStr || "" });
  const [searchString, setSearchString] = useState(routerSearchString);
  useEffect(() => {
    const sync = () => setSearchString(window.location.search);
    setSearchString(routerSearchString || window.location.search);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [landingPath, routerSearchString]);
  const params = useMemo(() => new URLSearchParams(searchString), [searchString]);
  const update = useCallback(
    (
      changes: Record<string, string | number | boolean | null | undefined>,
      mode: "push" | "replace" = "push",
      pathOverride?: string,
    ) => {
      if (typeof window === "undefined") return;
      const currentPath = window.location.pathname;
      const next = new URL(window.location.href);
      if (pathOverride) next.pathname = pathOverride;
      for (const [key, value] of Object.entries(changes)) {
        if (
          value === undefined ||
          value === null ||
          value === "" ||
          value === false ||
          value === "all" ||
          (value === 0 && key === "page")
        )
          next.searchParams.delete(key);
        else next.searchParams.set(key, String(value));
      }
      const href =
        next.pathname + (next.searchParams.size ? `?${next.searchParams}` : "") + next.hash;
      window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", href);
      setSearchString(next.search);
      // Native pushState does not emit popstate. Notify TanStack Router when the route itself changes
      // so StorePage's landing preset, head metadata, and URL remain in lockstep without a reload.
      if (next.pathname !== currentPath)
        window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    },
    [],
  );
  return { params, update };
}

function pathPreset(path: string) {
  const out: Record<string, string | boolean> = {};
  if (path.startsWith("/ebooks/")) out.taxonomy = decodeURIComponent(path.slice("/ebooks/".length));
  if (path === "/deals") out.deals = true;
  if (path === "/new-releases") {
    out.newRelease = true;
    out.sort = "released";
  }
  if (path === "/preorders") {
    out.preorder = true;
    out.sort = "coming_soon";
  }
  if (path === "/bestsellers") out.sort = "bestselling";
  if (path === "/trending") out.sort = "trending";
  if (path === "/most-read") out.sort = "most_read";
  if (path === "/most-wishlisted") out.sort = "most_wishlisted";
  if (path === "/new-and-noteworthy") out.sort = "noteworthy";
  if (path === "/top-rated") out.sort = "top_rated";
  return out;
}

export function visitorId() {
  if (typeof window === "undefined") return "";
  const key = "fore:merch-visitor:v1";
  let value = localStorage.getItem(key) || "";
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    value = crypto.randomUUID();
    localStorage.setItem(key, value);
  }
  return value;
}

function usePlacementImpression(
  placement: MerchPlacement | undefined,
  visitor: string,
  pageViewId: string,
  productId?: string | null,
  position?: number,
) {
  const ref = useRef<HTMLElement | null>(null);
  const sent = useRef("");
  useEffect(() => {
    const node = ref.current;
    if (!node || !placement || !visitor || !pageViewId) return;
    const signature = `${placement.id}:${pageViewId}:${productId || "placement"}:${position || 0}`;
    if (sent.current === signature) return;
    const fire = () => {
      if (sent.current === signature) return;
      sent.current = signature;
      void api("/merchandising/event", "POST", {
        type: "impression",
        placementId: placement.id,
        visitorId: visitor,
        pageViewId,
        productId: productId || null,
        position: position || null,
      }).catch(() => {});
    };
    if (!("IntersectionObserver" in window)) {
      fire();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)) {
          fire();
          observer.disconnect();
        }
      },
      { threshold: [0.5] },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [placement, visitor, pageViewId, productId, position]);
  return ref;
}

function MerchRail({
  placement,
  visitor,
  pageViewId,
}: {
  placement: MerchPlacement;
  visitor: string;
  pageViewId: string;
}) {
  const impressionRef = usePlacementImpression(placement, visitor, pageViewId);
  if (!placement.books.length) return null;
  const logClick = (book?: CatalogBook, position?: number) => {
    if (!visitor || !pageViewId) return;
    void api("/merchandising/event", "POST", {
      type: "click",
      placementId: placement.id,
      visitorId: visitor,
      pageViewId,
      productId: book?.productId || null,
      position: position || null,
    }).catch(() => {});
  };
  return (
    <section className="merch-rail" data-placement={placement.id} ref={impressionRef}>
      <div className="merch-rail-heading">
        <div>
          <span className="small-label">{placement.eyebrow || "FORE EDITORS"}</span>
          <h2>{placement.title}</h2>
          {placement.body && <p>{placement.body}</p>}
        </div>
        {placement.ctaHref && (
          <a className="text-link" href={placement.ctaHref}>
            {placement.ctaLabel || "See all"} <ArrowRight size={16} />
          </a>
        )}
      </div>
      {placement.sponsored && (
        <p className="sponsored-label">Sponsored by {placement.sponsorName || "publisher"}</p>
      )}
      <div className="book-grid merch-grid">
        {placement.books.map((book, i) => (
          <BookCard
            key={String(book.productId || book.id)}
            book={book}
            onOpen={() => logClick(book, i + 1)}
          />
        ))}
      </div>
    </section>
  );
}

function flattenTaxonomy(nodes: TaxonomyNode[] = []): TaxonomyNode[] {
  return nodes.flatMap((node) => [node, ...flattenTaxonomy(node.children || [])]);
}

function TaxonomyBranch({
  node,
  activePath,
  depth = 0,
  countsPending = false,
}: {
  node: TaxonomyNode;
  activePath?: string;
  depth?: number;
  countsPending?: boolean;
}) {
  if (!countsPending && node.count <= 0) return null;
  return (
    <div className={depth === 0 ? "taxonomy-branch taxonomy-column" : "taxonomy-branch nested"}>
      <a
        className={
          (depth === 0 ? "taxonomy-root " : "") + (activePath === node.path ? "active" : "")
        }
        href={node.href}
      >
        {node.name}
        <small aria-label={countsPending ? "Count updating" : undefined}>
          {countsPending ? "…" : node.count.toLocaleString()}
        </small>
      </a>
      {node.children
        .filter((child) => countsPending || child.count > 0)
        .map((child) => (
          <TaxonomyBranch
            key={child.id}
            node={child}
            activePath={activePath}
            depth={depth + 1}
            countsPending={countsPending}
          />
        ))}
    </div>
  );
}

function MerchBanner({
  placement,
  visitor,
  pageViewId,
}: {
  placement: MerchPlacement;
  visitor: string;
  pageViewId: string;
}) {
  const firstBook = placement.books[0];
  const href = placement.ctaHref || (firstBook ? productPath(firstBook) : "");
  const impressionRef = usePlacementImpression(
    placement,
    visitor,
    pageViewId,
    firstBook?.productId || null,
    firstBook ? 1 : undefined,
  );
  if (!placement.title && !placement.body && !placement.imageUrl) return null;
  const logClick = () => {
    if (!visitor || !pageViewId) return;
    void api("/merchandising/event", "POST", {
      type: "click",
      placementId: placement.id,
      visitorId: visitor,
      pageViewId,
      productId: firstBook?.productId || null,
      position: firstBook ? 1 : null,
    }).catch(() => {});
  };
  return (
    <section className="merch-banner" data-placement={placement.id} ref={impressionRef}>
      {placement.imageUrl && <img src={placement.imageUrl} alt="" loading="lazy" />}
      <div className="merch-banner-overlay">
        <span className="small-label">{placement.eyebrow || "FORE EDITORS"}</span>
        {placement.sponsored && (
          <span className="sponsored-label">
            Sponsored by {placement.sponsorName || "publisher"}
          </span>
        )}
        <h2>{placement.title}</h2>
        {placement.body && <p>{placement.body}</p>}
        {href && (
          <a className="button gold" href={href} onClick={logClick}>
            {placement.ctaLabel || "Explore"} <ArrowRight size={17} />
          </a>
        )}
      </div>
    </section>
  );
}

function TaxonomyBrowse({
  taxonomy,
  activePath,
}: {
  taxonomy?: TaxonomyResponse;
  activePath?: string;
}) {
  if (!taxonomy?.nodes?.length) return null;
  const countsPending = taxonomy.countsPending === true;
  return (
    <details className="taxonomy-browser" open={!!activePath}>
      <summary>
        Browse categories <ChevronDown size={16} />
      </summary>
      <div className="taxonomy-mega">
        {taxonomy.nodes
          .filter((n) => countsPending || n.count > 0)
          .map((root) => (
            <TaxonomyBranch
              key={root.id}
              node={root}
              activePath={activePath}
              countsPending={countsPending}
            />
          ))}
      </div>
    </details>
  );
}

export function StorePage({
  landingPath = "/",
  initial,
}: {
  landingPath?: string;
  initial?: StorefrontBootstrap | null;
}) {
  const storefront = useStorefrontLocale();
  const { data } = useAccount();
  const { params: url, update } = useUrlSearch(landingPath);
  const routePreset = pathPreset(landingPath);
  const q = url.get("q") || url.get("search") || "";
  const [query, setQuery] = useState(q);
  const [suggestQuery, setSuggestQuery] = useState(q);
  const [searchFocused, setSearchFocused] = useState(false);
  const [visitor, setVisitor] = useState("");
  const [pageViewId, setPageViewId] = useState("");
  const matchingInitial =
    initial &&
    initial.context.rightsCountry === storefront.rightsCountry &&
    initial.context.locale === storefront.locale &&
    initial.context.currency === storefront.currency
      ? initial
      : undefined;
  const storefrontPage = useQuery<StorefrontPage>({
    queryKey: ["storefront-page", landingPath, storefront.rightsCountry, storefront.locale],
    queryFn: () => api("/storefront/page?path=" + encodeURIComponent(landingPath)),
    staleTime: 15 * 60_000,
    gcTime: typeof window === "undefined" ? Infinity : 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: 0,
    initialData: matchingInitial?.page,
    initialDataUpdatedAt: matchingInitial?.at,
  });
  const cmsPreset = storefrontPage.data?.query || {};
  const presetValue = (key: string) => cmsPreset[key] ?? routePreset[key];
  const presetFirst = (key: string) =>
    Array.isArray(presetValue(key))
      ? String((presetValue(key) as unknown[])[0] || "")
      : String(presetValue(key) || "");
  const presetTaxonomy = Array.isArray(presetValue("taxonomy"))
    ? String((presetValue("taxonomy") as unknown[])[0] || "")
    : String(presetValue("taxonomy") || "");
  const taxonomyPath = url.get("taxonomy") || presetTaxonomy;
  const language = url.get("language") || String(presetValue("language") || "all");
  const format = url.get("format") || String(presetValue("format") || "all");
  const publisher = url.get("publisher") || String(presetValue("publisher") || "all");
  const series = url.get("series") || String(presetValue("series") || "all");
  const authorId = url.get("authorId") || presetFirst("authorId");
  const seriesId = url.get("seriesId") || presetFirst("seriesId");
  const publisherId = url.get("publisherId") || presetFirst("publisherId");
  const imprintId = url.get("imprintId") || presetFirst("imprintId");
  const deals = url.get("deals") === "true" || presetValue("deals") === true;
  const preorders = url.get("preorder") === "true" || presetValue("preorder") === true;
  const newReleases = url.get("newRelease") === "true" || presetValue("newRelease") === true;
  const subscriptionOnly =
    url.get("subscription") === "true" || presetValue("subscription") === true;
  const libraryOnly = url.get("library") === "true" || presetValue("library") === true;
  const minRating = url.get("minRating") || String(presetValue("minRating") || "all");
  const minPrice = url.get("minPrice") || String(presetValue("minPrice") || "");
  const maxPrice = url.get("maxPrice") || String(presetValue("maxPrice") || "");
  const publishedAfter = url.get("publishedAfter") || String(presetValue("publishedAfter") || "");
  const publishedBefore =
    url.get("publishedBefore") || String(presetValue("publishedBefore") || "");
  const page = Math.max(1, Number(url.get("page") || 1) || 1);
  const explicitSort = url.get("sort");
  const sort = explicitSort || String(presetValue("sort") || (q ? "relevance" : "popular"));

  useEffect(() => setQuery(q), [q]);
  useEffect(() => setVisitor(visitorId()), []);
  useEffect(() => {
    if (typeof window !== "undefined") setPageViewId(crypto.randomUUID());
  }, [landingPath, url.toString()]);
  useEffect(() => {
    const redirectTo = storefrontPage.data?.redirectTo;
    if (!redirectTo || typeof window === "undefined" || window.location.pathname === redirectTo)
      return;
    window.location.replace(redirectTo);
  }, [storefrontPage.data?.redirectTo]);
  useEffect(() => {
    const t = setTimeout(() => {
      const next = query.trim();
      const path = next && ["/", "/store"].includes(landingPath) ? "/search" : undefined;
      update(
        {
          q: next || null,
          page: null,
          sort: next && !explicitSort ? "relevance" : explicitSort || null,
        },
        "replace",
        path,
      );
    }, 400);
    return () => clearTimeout(t);
  }, [query, explicitSort, landingPath, update]);
  useEffect(() => {
    const t = setTimeout(() => setSuggestQuery(query.trim()), 160);
    return () => clearTimeout(t);
  }, [query]);

  const taxonomy = useQuery<TaxonomyResponse>({
    queryKey: ["storefront-taxonomy", language, storefront.rightsCountry, storefront.locale],
    queryFn: () =>
      api("/taxonomy" + (language !== "all" ? "?language=" + encodeURIComponent(language) : "")),
    staleTime: 30 * 60_000,
    refetchInterval: (query) => (query.state.data?.countsPending ? 5_000 : false),
    gcTime: typeof window === "undefined" ? Infinity : 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    initialData: language === "all" ? matchingInitial?.taxonomy : undefined,
    initialDataUpdatedAt: matchingInitial?.at,
  });
  useEffect(() => {
    const page = storefrontPage.data;
    if (!page || typeof document === "undefined" || page.redirectTo) return;
    document.title = page.seoTitle || `${page.title || "Bookstore"} | Cove`;
    const setMeta = (selector: string, attr: "name" | "rel", key: string, value: string) => {
      let el = document.head.querySelector<HTMLMetaElement | HTMLLinkElement>(selector);
      if (!el) {
        el = document.createElement(attr === "rel" ? "link" : "meta") as
          HTMLMetaElement | HTMLLinkElement;
        el.setAttribute(attr, key);
        el.setAttribute("data-fore-storefront", "1");
        document.head.appendChild(el);
      }
      if (el instanceof HTMLLinkElement) el.href = value;
      else el.content = value;
    };
    if (page.seoDescription)
      setMeta(
        'meta[name="description"][data-fore-storefront]',
        "name",
        "description",
        page.seoDescription,
      );
    const canonicalPath = page.canonical || landingPath;
    const canonical =
      typeof window !== "undefined"
        ? new URL(canonicalPath, window.location.origin).href
        : canonicalPath;
    setMeta('link[rel="canonical"][data-fore-storefront]', "rel", "canonical", canonical);
    // Arbitrary filtered/search URLs remain shareable but should not explode the SEO index.
    // Curated landing/category/entity URLs without query parameters remain indexable.
    const hasUrlFilters =
      typeof window !== "undefined" && new URLSearchParams(window.location.search).size > 0;
    if (page.noindex || landingPath === "/search" || hasUrlFilters)
      setMeta('meta[name="robots"][data-fore-storefront]', "name", "robots", "noindex,follow");
    return () => {
      document.head.querySelectorAll('[data-fore-storefront="1"]').forEach((node) => node.remove());
    };
  }, [storefrontPage.data, landingPath, url.toString()]);

  const params = new URLSearchParams({
    search: q,
    sort,
    page: String(page),
    currency: storefront.currency,
  });
  if (taxonomyPath) params.set("taxonomy", taxonomyPath);
  if (language !== "all") params.set("language", language);
  if (format !== "all") params.set("format", format);
  if (publisher !== "all") params.set("publisher", publisher);
  if (series !== "all") params.set("series", series);
  if (authorId) params.set("authorId", authorId);
  if (seriesId) params.set("seriesId", seriesId);
  if (publisherId) params.set("publisherId", publisherId);
  if (imprintId) params.set("imprintId", imprintId);
  if (deals) params.set("deals", "true");
  if (preorders) params.set("preorder", "true");
  if (newReleases) params.set("newRelease", "true");
  if (subscriptionOnly) params.set("subscription", "true");
  if (libraryOnly) params.set("library", "true");
  if (minRating !== "all") params.set("minRating", minRating);
  if (minPrice) params.set("minPrice", minPrice);
  if (maxPrice) params.set("maxPrice", maxPrice);
  if (publishedAfter) params.set("publishedAfter", publishedAfter);
  if (publishedBefore) params.set("publishedBefore", publishedBefore);

  // Cold HTML can have no SSR bootstrap after the strict rights-fetch deadline.
  // In that case, get the same freshly authorized 24-book first-paint shelf
  // rather than blocking visible cards on the full catalog COUNT and facets.
  // The ordinary /catalog request still runs after these cards appear, keeping
  // accurate filters, pagination totals and account-specific rules.
  const fastAnonymousHome =
    !data.user &&
    (landingPath === "/" || landingPath === "/store") &&
    page === 1 &&
    sort === "popular" &&
    !q &&
    params.toString() ===
      new URLSearchParams({
        search: "",
        sort: "popular",
        page: "1",
        currency: storefront.currency,
      }).toString();
  const fastShelf = useQuery<CatalogResponse>({
    queryKey: [
      "bookstore-first-paint",
      "v1",
      storefront.rightsCountry,
      storefront.currency,
      storefront.locale,
    ],
    queryFn: async ({ signal }) => {
      const live = await api<StorefrontBootstrap>("/storefront/bootstrap", "GET", undefined, {
        signal,
        retryReads: false,
      });
      return verifiedFirstPageShelf(live, {
        country: storefront.rightsCountry,
        currency: storefront.currency,
        locale: storefront.locale,
        query: params.toString(),
      });
    },
    enabled: typeof window !== "undefined" && fastAnonymousHome && !matchingInitial?.catalog,
    staleTime: 30_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const fastPreview = fastAnonymousHome ? fastShelf.data : undefined;
  // An unavailable or slow bootstrap must not hold the ordinary catalog request
  // hostage indefinitely. Give the narrow rights-scoped shelf first chance to
  // paint, then start the independently authorized full catalog on a bounded
  // timer. Never substitute an unverified or cross-market cached book.
  const [catalogFallbackReady, setCatalogFallbackReady] = useState(false);
  useEffect(() => {
    if (!fastAnonymousHome || matchingInitial?.catalog || fastPreview || fastShelf.isError) return;
    const timeout = window.setTimeout(() => setCatalogFallbackReady(true), 800);
    return () => window.clearTimeout(timeout);
  }, [fastAnonymousHome, matchingInitial?.catalog, fastPreview, fastShelf.isError, params.toString()]);

  // SSR already includes 24 *fresh, canonical rights-checked* book cards.
  // Avoid an immediate, heavyweight full-catalog read during critical paint:
  // the live API still re-authorizes every product detail, checkout and EPUB.
  const initialPreview =
    !data.user &&
    matchingInitial?.catalog.preview === true &&
    matchingInitial.catalogQuery === params.toString();
  const result = useQuery<CatalogResponse>({
    queryKey: [
      "catalog",
      "v3",
      params.toString(),
      storefront.rightsCountry,
      storefront.locale,
      data.user?.id || "guest",
    ],
    queryFn: ({ signal }) => api("/catalog?" + params, "GET", undefined, { signal }),
    // Wait for the small live-rights shelf (or its explicit failure) before
    // starting the 20s cold COUNT/facet request on an unbootstrapped homepage.
    enabled:
      !fastAnonymousHome ||
      !!matchingInitial?.catalog ||
      !!fastPreview ||
      fastShelf.isError ||
      catalogFallbackReady,
    placeholderData: fastAnonymousHome ? fastPreview : undefined,
    // A brief first-paint grace period prevents 24-card preview hydration
    // from competing with the very next server request for D1 capacity.
    // A bounded background refresh follows once the visual path has settled.
    staleTime: initialPreview ? 4_000 : 5 * 60_000,
    gcTime: typeof window === "undefined" ? Infinity : 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    initialData:
      !data.user && matchingInitial?.catalogQuery === params.toString()
        ? matchingInitial.catalog
        : undefined,
    initialDataUpdatedAt: matchingInitial?.at,
  });
  useEffect(() => {
    if (!initialPreview || result.data?.preview !== true) return;
    let refreshed = false;
    const refresh = () => {
      if (document.visibilityState !== "visible" || refreshed) return;
      refreshed = true;
      document.removeEventListener("visibilitychange", refresh);
      void result.refetch();
    };
    // Never persist or replay an unverified catalog across visits or markets.
    // Query key changes cancel this delay; user actions still hit live APIs.
    const timer = window.setTimeout(refresh, 4_500);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [initialPreview, result.data?.preview, result.refetch, params.toString()]);

  useEffect(() => {
    const queryId = result.data?.search?.queryId;
    if (!visitor || !queryId) return;
    void api("/events", "POST", {
      eventType: "search_performed",
      anonymousId: visitor,
      queryId,
      sourceSurface: landingPath || "/store",
      properties: { query: q, sort, resultCount: result.data?.count || 0 },
      dedupeKey: `search:${queryId}`,
    }).catch(() => {});
  }, [result.data?.search?.queryId, visitor, landingPath, q, sort, result.data?.count]);
  const suggestions = useQuery<{
    suggestions: {
      type: string;
      productId: string;
      bookId: string;
      label: string;
      sublabel: string;
    }[];
  }>({
    queryKey: ["catalog-suggestions", suggestQuery, storefront.rightsCountry, storefront.locale],
    queryFn: ({ signal }) =>
      api("/search/suggest?q=" + encodeURIComponent(suggestQuery), "GET", undefined, { signal }),
    enabled: searchFocused && suggestQuery.length >= 2,
    staleTime: 5 * 60_000,
    gcTime: typeof window === "undefined" ? Infinity : 30 * 60_000,
    retry: 0,
  });

  const filtered = !!(
    q ||
    taxonomyPath ||
    language !== "all" ||
    format !== "all" ||
    publisher !== "all" ||
    series !== "all" ||
    authorId ||
    seriesId ||
    publisherId ||
    imprintId ||
    deals ||
    preorders ||
    newReleases ||
    subscriptionOnly ||
    libraryOnly ||
    minRating !== "all" ||
    minPrice ||
    maxPrice ||
    publishedAfter ||
    publishedBefore
  );
  // A failed slow COUNT/facet request must never erase a verified live
  // first-paint shelf. This is display-only; no rights or entitlements
  // are conferred by the preview.
  const catalogDisplay = result.data ?? fastPreview;
  const books = catalogDisplay?.results || [];
  const home = ["/", "/store"].includes(landingPath) && !filtered && page === 1;
  const merch = useQuery<MerchResponse>({
    queryKey: ["merchandising", visitor, !!data.user],
    queryFn: () => api(`/merchandising?visitor=${encodeURIComponent(visitor)}`),
    enabled: home && !!visitor && books.length > 0,
    staleTime: 60_000,
    retry: 1,
  });
  const recommendations = useQuery<RecommendationResponse>({
    queryKey: ["recommendations-home", visitor, data.user?.id || "anonymous"],
    queryFn: () => api(`/recommendations/home?visitor=${encodeURIComponent(visitor)}&limit=12`),
    enabled: home && !!visitor && books.length > 0,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const current = data.library
    .filter((x) => x.status === "reading")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const hero = merch.data?.slots?.["home.hero"]?.[0];
  const heroBook = hero?.books?.[0];
  const heroImpressionRef = usePlacementImpression(
    hero,
    visitor,
    pageViewId,
    heroBook?.productId || null,
    heroBook ? 1 : undefined,
  );
  const banners = merch.data?.slots?.["home.campaign"] || [];
  const rails = [
    ...(merch.data?.slots?.["home.primary"] || []),
    ...(merch.data?.slots?.["home.secondary"] || []),
  ];
  const heading =
    storefrontPage.data?.heading ||
    (landingPath === "/search" ? "Search the bookstore" : "Find your next great read.");
  const eyebrow = storefrontPage.data?.eyebrow || "THE BOOKSTORE";
  const description =
    storefrontPage.data?.description || "Stories to get lost in. Ideas to carry with you.";

  function setFilter(
    key: string,
    value: string | boolean | null,
    mode: "push" | "replace" = "push",
  ) {
    update({ [key]: value, page: null }, mode);
  }
  function clearFilters() {
    const presetLanding =
      landingPath.startsWith("/ebooks/") ||
      landingPath.startsWith("/campaign/") ||
      landingPath.startsWith("/author/") ||
      landingPath.startsWith("/series/") ||
      landingPath.startsWith("/publisher/") ||
      landingPath.startsWith("/imprint/") ||
      ["/deals", "/new-releases", "/preorders", "/bestsellers"].includes(landingPath);
    update(
      {
        q: null,
        sort: null,
        taxonomy: null,
        language: null,
        format: null,
        publisher: null,
        series: null,
        authorId: null,
        seriesId: null,
        publisherId: null,
        imprintId: null,
        deals: null,
        preorder: null,
        newRelease: null,
        subscription: null,
        library: null,
        minRating: null,
        minPrice: null,
        maxPrice: null,
        publishedAfter: null,
        publishedBefore: null,
        page: null,
      },
      "push",
      presetLanding ? "/store" : undefined,
    );
  }
  function toggleLandingFilter(
    key: "deals" | "newRelease" | "preorder",
    active: boolean,
    activePath: string,
  ) {
    if (active && landingPath === activePath)
      update({ [key]: null, sort: null, page: null }, "push", "/store");
    else setFilter(key, active ? null : true);
  }
  function chooseTaxonomy(next: string) {
    if (next === "all") {
      update(
        { taxonomy: null, page: null },
        "push",
        landingPath.startsWith("/ebooks/") ? "/store" : undefined,
      );
      return;
    }
    if (landingPath.startsWith("/ebooks/"))
      update({ taxonomy: null, page: null }, "push", `/ebooks/${next}`);
    else setFilter("taxonomy", next);
  }

  return (
    <div className="store-page">
      <div className="page-eyebrow">
        {eyebrow}{" "}
        <span>
          {landingPath === "/" || landingPath === "/store"
            ? "Good books. Open to everyone."
            : storefrontPage.data?.title || "Browse Cove"}
        </span>
      </div>
      <div className="page-heading">
        <div>
          <h1>
            {heading}
            <span className="gold-text">.</span>
          </h1>
          <p>{description}</p>
        </div>
        <a className="text-link desktop-only" href="/library">
          Your library <ArrowUpRight size={17} />
        </a>
      </div>
      {storefrontPage.data?.entity && storefrontPage.data.pageType !== "series" && (
        <section className="entity-profile-card">
          {storefrontPage.data.entity.imageUrl && (
            <img src={storefrontPage.data.entity.imageUrl} alt="" />
          )}
          <div>
            <span className="small-label">{storefrontPage.data.entity.type.toUpperCase()}</span>
            <h2>{storefrontPage.data.entity.name}</h2>
            {storefrontPage.data.entity.publisherName && (
              <p>
                Part of{" "}
                <a
                  href={`/publisher/${encodeURIComponent(storefrontPage.data.entity.publisherSlug || storefrontPage.data.entity.publisherId || "")}`}
                >
                  {storefrontPage.data.entity.publisherName}
                </a>
              </p>
            )}
            {storefrontPage.data.entity.website && (
              <a
                className="text-link"
                href={storefrontPage.data.entity.website}
                target="_blank"
                rel="noreferrer"
              >
                Official site <ArrowUpRight size={14} />
              </a>
            )}
            {!!storefrontPage.data.entity.imprints?.length && (
              <div className="entity-related-block">
                <span className="small-label">IMPRINTS</span>
                <div className="entity-related-links">
                  {storefrontPage.data.entity.imprints.map((x) => (
                    <a key={x.id} href={`/imprint/${encodeURIComponent(x.slug || x.id)}`}>
                      {x.name}
                    </a>
                  ))}
                </div>
              </div>
            )}
            {!!storefrontPage.data.entity.series?.length && (
              <div className="entity-related-block">
                <span className="small-label">SERIES & COLLECTIONS</span>
                <div className="entity-related-links">
                  {storefrontPage.data.entity.series.map((x) => (
                    <a key={x.id} href={`/series/${encodeURIComponent(x.slug || x.id)}`}>
                      {x.name}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}
      {!!storefrontPage.data?.breadcrumbs?.length && (
        <nav className="store-breadcrumbs" aria-label="Breadcrumb">
          <a href="/store">eBooks</a>
          <span aria-hidden="true">/</span>
          {storefrontPage.data.breadcrumbs.map((crumb, index) => (
            <span key={crumb.id}>
              {index > 0 && <span aria-hidden="true">/</span>}
              <a
                href={crumb.href}
                aria-current={
                  index === (storefrontPage.data?.breadcrumbs?.length || 0) - 1 ? "page" : undefined
                }
              >
                {crumb.name}
              </a>
            </span>
          ))}
        </nav>
      )}
      {!!storefrontPage.data?.children?.length && (
        <div
          className="subcategory-grid"
          aria-label={`Browse within ${storefrontPage.data.title || "this category"}`}
        >
          {storefrontPage.data.children.map((child) => (
            <a key={child.id} href={child.href}>
              <strong>{child.name}</strong>
              {child.description && <small>{child.description}</small>}
            </a>
          ))}
        </div>
      )}

      <div className="catalog-search">
        <Search size={21} />
        <input
          aria-label="Search books by title, author, series, ISBN, publisher, or catalog ID"
          placeholder="Search titles, authors, series, ISBNs, publishers…"
          value={query}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setTimeout(() => setSearchFocused(false), 120)}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        {query && (
          <button className="text-link" onClick={() => setQuery("")}>
            Clear
          </button>
        )}
        <kbd>/</kbd>
        {searchFocused && query.trim().length >= 2 && !!suggestions.data?.suggestions?.length && (
          <div className="search-suggestions" role="listbox" aria-label="Search suggestions">
            {suggestions.data.suggestions.map((suggestion) => (
              <a key={suggestion.productId} href={bookPath(suggestion.bookId)} role="option">
                <Search size={15} />
                <span>
                  <strong>{suggestion.label}</strong>
                  <small>{suggestion.sublabel}</small>
                </span>
                <ArrowUpRight size={14} />
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="commercial-shortcuts" aria-label="Bookstore destinations">
        <a href="/bestsellers">Bestsellers</a>
        <a href="/new-releases">New releases</a>
        <a href="/preorders">Coming soon</a>
        <a href="/deals">Deals</a>
      </div>
      <TaxonomyBrowse taxonomy={taxonomy.data} activePath={taxonomyPath} />

      <div className="catalog-controls">
        <div className="topic-tabs" role="group" aria-label="Featured book categories">
          <a className={!taxonomyPath ? "active" : ""} href="/store">
            All books
          </a>
          {(taxonomy.data?.countsPending
            ? flattenTaxonomy(taxonomy.data.nodes).filter((node) => node.featured)
            : taxonomy.data?.featured || []
          )
            .slice(0, 9)
            .map((node) => (
              <a
                key={node.id}
                href={node.href}
                className={taxonomyPath === node.path ? "active" : ""}
              >
                {node.name}
              </a>
            ))}
        </div>
        <div className="filter-row">
          <span className="catalog-count">
            {result.isFetching && !result.data
              ? "Finding books…"
              : catalogDisplay?.preview
                ? "Books available to read"
                : `${catalogDisplay?.count?.toLocaleString() || 0} books`}
            {catalogDisplay?.ingestion?.status === "running" && <small> · Catalog updating</small>}
          </span>
          <div className="filter-selects">
            <Select
              value={language}
              onValueChange={(v) => setFilter("language", v === "all" ? null : v)}
            >
              <SelectTrigger aria-label="Book language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All languages</SelectItem>
                {(catalogDisplay?.facets?.languages || []).slice(0, 40).map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {x.value.toUpperCase()} ({x.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={format}
              onValueChange={(v) => setFilter("format", v === "all" ? null : v)}
            >
              <SelectTrigger aria-label="Book format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All formats</SelectItem>
                {(catalogDisplay?.facets?.formats || []).map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {x.value} ({x.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => update({ sort: v, page: null }, "push")}>
              <SelectTrigger aria-label="Sort books">
                <SlidersHorizontal size={15} />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {q && <SelectItem value="relevance">Best match</SelectItem>}
                <SelectItem value="bestselling">Bestselling on Cove</SelectItem>
                <SelectItem value="trending">Trending on Cove</SelectItem>
                <SelectItem value="most_read">Most read</SelectItem>
                <SelectItem value="most_wishlisted">Most wishlisted</SelectItem>
                <SelectItem value="noteworthy">New & noteworthy</SelectItem>
                <SelectItem value="top_rated">Top rated</SelectItem>
                <SelectItem value="released">Recently released</SelectItem>
                <SelectItem value="published">Recently published</SelectItem>
                <SelectItem value="added">Recently added to Cove</SelectItem>
                <SelectItem value="updated">Recently updated</SelectItem>
                <SelectItem value="coming_soon">Coming soon</SelectItem>
                <SelectItem value="price_asc">Price: low to high</SelectItem>
                <SelectItem value="price_desc">Price: high to low</SelectItem>
                <SelectItem value="title">Title A–Z</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="search-facets" aria-label="Search filters">
        <Select value={taxonomyPath || "all"} onValueChange={chooseTaxonomy}>
          <SelectTrigger aria-label="Retail category">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {flattenTaxonomy(taxonomy.data?.nodes || [])
              .filter((x) => x.count > 0)
              .map((x) => (
                <SelectItem key={x.id} value={x.path}>
                  {x.depth ? `${"—".repeat(Math.min(x.depth, 3))} ` : ""}
                  {x.name} ({x.count})
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Select
          value={publisher}
          onValueChange={(v) => setFilter("publisher", v === "all" ? null : v)}
        >
          <SelectTrigger aria-label="Publisher">
            <SelectValue placeholder="Publisher" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All publishers</SelectItem>
            {(catalogDisplay?.facets?.publishers || []).slice(0, 30).map((x) => (
              <SelectItem key={x.value} value={x.value}>
                {x.value} ({x.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={series} onValueChange={(v) => setFilter("series", v === "all" ? null : v)}>
          <SelectTrigger aria-label="Series">
            <SelectValue placeholder="Series" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All series</SelectItem>
            {(catalogDisplay?.facets?.series || []).slice(0, 30).map((x) => (
              <SelectItem key={x.value} value={x.value}>
                {x.value} ({x.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          className={deals ? "facet-toggle active" : "facet-toggle"}
          onClick={() => toggleLandingFilter("deals", deals, "/deals")}
        >
          Deals
        </button>
        <button
          className={newReleases ? "facet-toggle active" : "facet-toggle"}
          onClick={() => toggleLandingFilter("newRelease", newReleases, "/new-releases")}
        >
          New releases
        </button>
        <button
          className={preorders ? "facet-toggle active" : "facet-toggle"}
          onClick={() => toggleLandingFilter("preorder", preorders, "/preorders")}
        >
          Preorders
        </button>
        <button
          className={subscriptionOnly ? "facet-toggle active" : "facet-toggle"}
          onClick={() => setFilter("subscription", subscriptionOnly ? null : true)}
        >
          Subscription
        </button>
        <button
          className={libraryOnly ? "facet-toggle active" : "facet-toggle"}
          onClick={() => setFilter("library", libraryOnly ? null : true)}
        >
          Library eligible
        </button>
        <Select
          value={minRating}
          onValueChange={(v) => setFilter("minRating", v === "all" ? null : v)}
        >
          <SelectTrigger aria-label="Minimum rating">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any rating</SelectItem>
            <SelectItem value="4">4★ & up</SelectItem>
            <SelectItem value="3">3★ & up</SelectItem>
            <SelectItem value="2">2★ & up</SelectItem>
          </SelectContent>
        </Select>
        <label className="facet-field">
          <span>Min $</span>
          <input
            inputMode="decimal"
            aria-label="Minimum price"
            value={minPrice}
            onChange={(e) =>
              setFilter("minPrice", e.target.value.replace(/[^0-9.]/g, ""), "replace")
            }
            placeholder="0"
          />
        </label>
        <label className="facet-field">
          <span>Max $</span>
          <input
            inputMode="decimal"
            aria-label="Maximum price"
            value={maxPrice}
            onChange={(e) =>
              setFilter("maxPrice", e.target.value.replace(/[^0-9.]/g, ""), "replace")
            }
            placeholder="Any"
          />
        </label>
        <label className="facet-field date">
          <span>Published after</span>
          <input
            type="date"
            aria-label="Published after"
            value={publishedAfter}
            onChange={(e) => setFilter("publishedAfter", e.target.value)}
          />
        </label>
        <label className="facet-field date">
          <span>Before</span>
          <input
            type="date"
            aria-label="Published before"
            value={publishedBefore}
            onChange={(e) => setFilter("publishedBefore", e.target.value)}
          />
        </label>
        {filtered && (
          <button className="text-link" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {catalogDisplay?.search?.correctedQuery && (
        <p className="search-correction">
          Showing results for <strong>{catalogDisplay.search.correctedQuery}</strong>.
        </p>
      )}
      {catalogDisplay?.warning &&
        (!books.length || !catalogDisplay.warning.includes("catalog updater is retrying")) && (
          <p className="notice">{catalogDisplay.warning}</p>
        )}
      {result.error && !books.length ? (
        <div className="empty-state">
          <h2>The catalog needs a moment.</h2>
          <p>{result.error.message}</p>
          <button className="button gold" onClick={() => result.refetch()}>
            Try again
          </button>
        </div>
      ) : result.isLoading && !books.length ? (
        <div className="book-grid">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i}>
              <Skeleton className="aspect-[2/3] w-full rounded-sm" />
              <Skeleton className="mt-4 h-5 w-4/5" />
            </div>
          ))}
        </div>
      ) : books.length ? (
        <div className="book-grid">
          {books.map((b, index) => (
            <BookCard
              key={String(b.productId || b.id)}
              book={b}
              priority={page === 1 && index < 2}
              onOpen={() => {
                const queryId = catalogDisplay?.search?.queryId;
                const position = (page - 1) * (catalogDisplay?.search?.pageSize || 24) + index + 1;
                if (queryId && b.productId) {
                  void api("/search/click", "POST", {
                    queryId,
                    productId: b.productId,
                    position,
                  }).catch(() => {});
                  if (visitor)
                    void api("/events", "POST", {
                      eventType: "search_result_clicked",
                      anonymousId: visitor,
                      productId: b.productId,
                      externalBookId: String(b.sourceExternalId || b.id),
                      queryId,
                      sourceSurface: landingPath || "/store",
                      properties: { position },
                      dedupeKey: `search-click:${queryId}:${b.productId}:${position}`,
                    }).catch(() => {});
                }
              }}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Search />
          <h2>No books found</h2>
          <p>Try an author’s surname, a shorter title, or another category.</p>
          <button className="button outline" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      )}

      {!result.isLoading && books.length > 0 && (
        <div className="pagination">
          <button
            className="button outline"
            disabled={page === 1}
            onClick={() => {
              update({ page: Math.max(1, page - 1) }, "push");
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            <ChevronLeft size={17} /> Previous
          </button>
          <span>Page {page}</span>
          <button
            className="button outline"
            disabled={!catalogDisplay?.next}
            onClick={() => {
              update({ page: page + 1 }, "push");
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            Next <ChevronRight size={17} />
          </button>
        </div>
      )}

      {/* Optional discovery modules follow the stable first-page catalog. */}
      {home && heroBook && hero && (
        <div className="discovery-row">
          <section className="featured-book" data-placement={hero.id} ref={heroImpressionRef}>
            <div className="feature-copy">
              <span className="feature-label">{hero.eyebrow || "THE FORE EDIT"}</span>
              {hero.sponsored && (
                <span className="sponsored-label">
                  Sponsored by {hero.sponsorName || "publisher"}
                </span>
              )}
              <h2>{hero.title || heroBook.title}</h2>
              <p>{authorOf(heroBook)}</p>
              <p className="feature-description">
                {hero.body || heroBook.summaries?.[0]?.slice(0, 220)}
                {!hero.body && (heroBook.summaries?.[0]?.length || 0) > 220 ? "…" : ""}
              </p>
              <a
                className="button gold"
                href={editionPath(heroBook)}
                onClick={() => {
                  if (visitor && pageViewId)
                    void api("/merchandising/event", "POST", {
                      type: "click",
                      placementId: hero.id,
                      visitorId: visitor,
                      pageViewId,
                      productId: heroBook.productId || null,
                      position: 1,
                    }).catch(() => {});
                }}
              >
                {hero.ctaLabel || "Open this book"} <ArrowRight size={17} />
              </a>
            </div>
            <a
              href={editionPath(heroBook)}
              className="feature-cover"
              onClick={() => {
                if (visitor && pageViewId)
                  void api("/merchandising/event", "POST", {
                    type: "click",
                    placementId: hero.id,
                    visitorId: visitor,
                    pageViewId,
                    productId: heroBook.productId || null,
                    position: 1,
                  }).catch(() => {});
              }}
            >
              <BookArt book={heroBook} />
            </a>
          </section>
          <section className="reading-callout">
            <span className="small-label">
              {current ? "PICK UP WHERE YOU LEFT OFF" : "MAKE ROOM FOR READING"}
            </span>
            <BookOpen size={27} strokeWidth={1.3} />
            <h2>{current ? current.book.title : "A little reading.\nA world of possibility."}</h2>
            <p>
              {current
                ? `${Math.round(current.progress * 100)}% read · ${authorOf(current.book)}`
                : "Your books, best passages, and new words. All in one place."}
            </p>
            <a className="text-link" href={current ? readPath(current.bookId) : "/library"}>
              {current ? "Continue reading" : "Explore your library"} <ArrowRight size={17} />
            </a>
          </section>
        </div>
      )}

      {home &&
        banners.map((placement) => (
          <MerchBanner
            key={placement.id}
            placement={placement}
            visitor={visitor}
            pageViewId={pageViewId}
          />
        ))}
      {home &&
        rails.map((placement) => (
          <MerchRail
            key={placement.id}
            placement={placement}
            visitor={visitor}
            pageViewId={pageViewId}
          />
        ))}
      {home && <LiteraryDiscoveryPanel visitor={visitor} />}
      {home &&
        (recommendations.data?.rails || []).map((rail) => (
          <RecommendationRailView
            key={`${rail.key}:${rail.requestId}`}
            rail={rail}
            visitor={visitor}
          />
        ))}

      <footer className="site-footer">
        <span>
          FORE <span className="muted">· Read something that stays with you.</span>
        </span>
        <a href="/publishing-policy">Publishing & AI policy</a>
        <a href="/copyright">Copyright / DMCA</a>
        <a href="https://www.gutenberg.org" target="_blank" rel="noreferrer">
          Federated Gutenberg sources <ArrowUpRight size={13} />
        </a>
        <span>
          Availability follows the public-domain determination for your storefront country.
        </span>
      </footer>
    </div>
  );
}
