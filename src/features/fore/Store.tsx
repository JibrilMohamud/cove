import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import seed from "./catalog-seed.json";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
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
import { api, authorOf, coverOf, bookPath, productPath, editionPath, readPath, authorPath, seriesPath, useAccount, type CatalogBook } from "./client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

export function BookArt({ book, className = "" }: { book: CatalogBook; className?: string }) {
  const [broken, setBroken] = useState(false);
  const url = coverOf(book);
  return (
    <div className={"book-art " + className}>
      {url && !broken ? (
        <img src={url} onError={() => setBroken(true)} alt={"Cover of " + book.title} loading="lazy" />
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
  return <>{authors.map((author, index) => <span key={`${author.id || author.name}:${index}`}>{index > 0 ? ", " : ""}{author.id ? <a href={authorPath(author)}>{authorOf({ ...book, authors: [author] })}</a> : authorOf({ ...book, authors: [author] })}</span>)}</>;
}

function priceLabel(book: CatalogBook) {
  const offer = book.offer;
  if (!offer) return "Unavailable";
  if (Number(offer.amountMinor || 0) === 0) return "Free";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: offer.currency || "USD" }).format(Number(offer.amountMinor || 0) / 100);
  } catch {
    return `${offer.currency || "USD"} ${(Number(offer.amountMinor || 0) / 100).toFixed(2)}`;
  }
}

export function BookCard({ book, onOpen }: { book: CatalogBook; onOpen?: () => void }) {
  const { data, reload, signIn } = useAccount();
  const saved = data.library.some((x) => x.productId === String(book.productId||"") || x.book.publicProductId === book.publicProductId || x.bookId === String(book.sourceExternalId||book.id));
  const freeAccess = book.uploaded || book.copyright === false || (!!book.offer && Number(book.offer.amountMinor ?? 0) === 0);
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
      <a className="cover-link" href={editionPath(book)} onClick={onOpen}>
        <BookArt book={book} />
        <span className="cover-open">Explore book <ArrowUpRight size={17} /></span>
      </a>
      <div className="book-meta">
        <p className="book-genre">
          {book.series?.[0]?.id ? <a href={seriesPath(book.series[0])}>{book.series[0].name}</a> : (book.bookshelves?.find((s) => s.startsWith("Browsing: ")) || book.bookshelves?.find((s) => !s.startsWith("Browsing") && !/list|best|banned/i.test(s)) || book.subjects?.[0] || "Literature").replace(/^.*?: /, "").split(" -- ")[0]}
        </p>
        <a href={editionPath(book)} className="book-title" onClick={onOpen}>{book.title}</a>
        <p className="book-author"><AuthorLinks book={book} /></p>
        <div className="book-card-bottom">
          <span>{priceLabel(book)} <span className="epub-label">EPUB</span></span>
          {(saved || freeAccess) && <button className={"icon-button " + (saved ? "is-saved" : "")} aria-label={saved ? book.title + " is in your library" : "Add " + book.title + " to library"} disabled={saved || busy} onClick={add}>
            {busy ? <Loader2 size={17} className="spin" /> : saved ? <Check size={17} /> : <Plus size={19} />}
          </button>}
        </div>
      </div>
    </article>
  );
}

type FacetValue = { value: string; count: number };
type TaxonomyNode = { id: string; slug: string; path: string; depth: number; name: string; description: string; count: number; featured: boolean; href: string; children: TaxonomyNode[] };
type TaxonomyResponse = { taxonomy: string; version: string; featured: TaxonomyNode[]; nodes: TaxonomyNode[] };
type StorefrontPage = { path: string; pageType: string; title?: string; noindex?: boolean; heading?: string; eyebrow?: string; description?: string; seoTitle?: string; seoDescription?: string; canonical: string; query: Record<string, unknown>; redirectTo?: string; statusCode?: number; taxonomy?: { id: string; path: string; name: string }; breadcrumbs?: { id: string; name: string; path: string; href: string }[]; children?: { id: string; name: string; path: string; description: string; href: string }[]; entity?: { id:string; type:string; name:string; bio?:string; website?:string; description?:string; imageUrl?:string; publisherId?:string|null; publisherSlug?:string|null; publisherName?:string; seriesType?:string; imprints?:{id:string;name:string;slug:string}[]; series?:{id:string;name:string;slug:string;seriesType?:string}[] } };
type MerchPlacement = { id: string; campaignId: string; slotKey: string; type: string; sourceType: string; title: string; eyebrow: string; body: string; ctaLabel: string; ctaHref: string; imageUrl: string; badge: string; sponsored: boolean; sponsorName: string; experimentId: string | null; experimentVariant: string | null; books: CatalogBook[] };
type MerchResponse = { visitorId: string; slots: Record<string, MerchPlacement[]> };
type RecommendationRailData = { key: string; title: string; subtitle?: string; requestId: string; modelVersion: string; personalized: boolean; books: CatalogBook[]; items: { productId: string; score: number; reasonCode: string; reason: string }[] };
type RecommendationResponse = { rails: RecommendationRailData[]; personalization: { enabled: boolean; activityLearning: boolean; personalizedSearch: boolean }; model: { key: string; version: string; externalScorer?: boolean } };

function RecommendationCard({ rail, book, position, visitor }: { rail: RecommendationRailData; book: CatalogBook; position: number; visitor: string }) {
  const { data } = useAccount();
  const ref = useRef<HTMLDivElement | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const node=ref.current, productId=book.productId; if(!node||!productId||!visitor)return; let sent=false;
    const fire=()=>{if(sent)return;sent=true;void api("/recommendations/event","POST",{type:"recommendation_impression",productId,visitorId:visitor,requestId:rail.requestId,position,surface:`home:${rail.key}`}).catch(()=>{});};
    if(!("IntersectionObserver" in window)){fire();return;} const observer=new IntersectionObserver((entries)=>{if(entries.some((entry)=>entry.isIntersecting&&entry.intersectionRatio>=0.5)){fire();observer.disconnect();}},{threshold:[0.5]}); observer.observe(node); return()=>observer.disconnect();
  },[rail.requestId,rail.key,book.productId,position,visitor]);
  if(hidden)return null; const reason=rail.items.find((x)=>x.productId===book.productId)?.reason;
  return <div className="recommendation-card-wrap" ref={ref}><BookCard book={book} onOpen={()=>{if(book.productId)void api("/recommendations/event","POST",{type:"recommendation_click",productId:book.productId,visitorId:visitor,requestId:rail.requestId,position,surface:`home:${rail.key}`}).catch(()=>{});}} />{reason&&<p className="recommendation-reason">{reason}</p>}{data.user&&book.productId&&<button className="recommendation-hide" onClick={async()=>{setHidden(true);try{await api("/recommendations/feedback","POST",{entityType:"product",entityId:book.productId,action:"not_interested",reason:"home rail"});}catch{setHidden(false);}}}><EyeOff size={13}/> Not interested</button>}</div>;
}
function RecommendationRailView({ rail, visitor }: { rail: RecommendationRailData; visitor: string }) {
  if(!rail.books.length)return null; return <section className="recommendation-rail"><div className="merch-rail-heading"><div><span className="small-label">{rail.personalized?"PERSONALIZED FOR YOU":"FORE DISCOVERY"}</span><h2>{rail.title}</h2>{rail.subtitle&&<p>{rail.subtitle}</p>}</div></div><div className="book-grid merch-grid">{rail.books.map((book,index)=><RecommendationCard key={String(book.productId||book.id)} rail={rail} book={book} position={index+1} visitor={visitor}/>)}</div></section>;
}

type CatalogResponse = {
  results: CatalogBook[];
  count: number;
  next: string | null;
  cached?: boolean;
  warning?: string;
  ingestion?: { status: string; cachedBooks: number; totalCatalogCount: number };
  facets?: { categories: FacetValue[]; languages: FacetValue[]; formats: FacetValue[]; publishers: FacetValue[]; series: FacetValue[]; availability: FacetValue[]; price: { currency: string; min: number; max: number } | null };
  search?: { queryId: string | null; backend: string; processingTimeMs: number; correctedQuery?: string | null; pageSize?: number };
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
  const update = useCallback((changes: Record<string, string | number | boolean | null | undefined>, mode: "push" | "replace" = "push", pathOverride?: string) => {
    if (typeof window === "undefined") return;
    const currentPath = window.location.pathname;
    const next = new URL(window.location.href);
    if (pathOverride) next.pathname = pathOverride;
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === null || value === "" || value === false || value === "all" || value === 0 && key === "page") next.searchParams.delete(key);
      else next.searchParams.set(key, String(value));
    }
    const href = next.pathname + (next.searchParams.size ? `?${next.searchParams}` : "") + next.hash;
    window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", href);
    setSearchString(next.search);
    // Native pushState does not emit popstate. Notify TanStack Router when the route itself changes
    // so StorePage's landing preset, head metadata, and URL remain in lockstep without a reload.
    if (next.pathname !== currentPath) window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, []);
  return { params, update };
}

function pathPreset(path: string) {
  const out: Record<string, string | boolean> = {};
  if (path.startsWith("/ebooks/")) out.taxonomy = decodeURIComponent(path.slice("/ebooks/".length));
  if (path === "/deals") out.deals = true;
  if (path === "/new-releases") { out.newRelease = true; out.sort = "released"; }
  if (path === "/preorders") { out.preorder = true; out.sort = "coming_soon"; }
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

function usePlacementImpression(placement: MerchPlacement | undefined, visitor: string, pageViewId: string, productId?: string | null, position?: number) {
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
      void api("/merchandising/event", "POST", { type: "impression", placementId: placement.id, visitorId: visitor, pageViewId, productId: productId || null, position: position || null }).catch(() => {});
    };
    if (!("IntersectionObserver" in window)) { fire(); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)) { fire(); observer.disconnect(); }
    }, { threshold: [0.5] });
    observer.observe(node);
    return () => observer.disconnect();
  }, [placement, visitor, pageViewId, productId, position]);
  return ref;
}

function MerchRail({ placement, visitor, pageViewId }: { placement: MerchPlacement; visitor: string; pageViewId: string }) {
  const impressionRef = usePlacementImpression(placement, visitor, pageViewId);
  if (!placement.books.length) return null;
  const logClick = (book?: CatalogBook, position?: number) => {
    if (!visitor || !pageViewId) return;
    void api("/merchandising/event", "POST", { type: "click", placementId: placement.id, visitorId: visitor, pageViewId, productId: book?.productId || null, position: position || null }).catch(() => {});
  };
  return (
    <section className="merch-rail" data-placement={placement.id} ref={impressionRef}>
      <div className="merch-rail-heading">
        <div><span className="small-label">{placement.eyebrow || "FORE EDITORS"}</span><h2>{placement.title}</h2>{placement.body && <p>{placement.body}</p>}</div>
        {placement.ctaHref && <a className="text-link" href={placement.ctaHref}>{placement.ctaLabel || "See all"} <ArrowRight size={16} /></a>}
      </div>
      {placement.sponsored && <p className="sponsored-label">Sponsored by {placement.sponsorName || "publisher"}</p>}
      <div className="book-grid merch-grid">
        {placement.books.map((book, i) => <BookCard key={String(book.productId || book.id)} book={book} onOpen={() => logClick(book, i + 1)} />)}
      </div>
    </section>
  );
}


function flattenTaxonomy(nodes: TaxonomyNode[] = []): TaxonomyNode[] {
  return nodes.flatMap((node) => [node, ...flattenTaxonomy(node.children || [])]);
}

function TaxonomyBranch({ node, activePath, depth = 0 }: { node: TaxonomyNode; activePath?: string; depth?: number }) {
  if (node.count <= 0) return null;
  return (
    <div className={depth === 0 ? "taxonomy-branch taxonomy-column" : "taxonomy-branch nested"}>
      <a className={(depth === 0 ? "taxonomy-root " : "") + (activePath === node.path ? "active" : "")} href={node.href}>
        {node.name}<small>{node.count.toLocaleString()}</small>
      </a>
      {node.children.filter((child) => child.count > 0).map((child) => <TaxonomyBranch key={child.id} node={child} activePath={activePath} depth={depth + 1} />)}
    </div>
  );
}

function MerchBanner({ placement, visitor, pageViewId }: { placement: MerchPlacement; visitor: string; pageViewId: string }) {
  const firstBook = placement.books[0];
  const href = placement.ctaHref || (firstBook ? productPath(firstBook) : "");
  const impressionRef = usePlacementImpression(placement, visitor, pageViewId, firstBook?.productId || null, firstBook ? 1 : undefined);
  if (!placement.title && !placement.body && !placement.imageUrl) return null;
  const logClick = () => {
    if (!visitor || !pageViewId) return;
    void api("/merchandising/event", "POST", { type: "click", placementId: placement.id, visitorId: visitor, pageViewId, productId: firstBook?.productId || null, position: firstBook ? 1 : null }).catch(() => {});
  };
  return (
    <section className="merch-banner" data-placement={placement.id} ref={impressionRef}>
      {placement.imageUrl && <img src={placement.imageUrl} alt="" loading="lazy" />}
      <div className="merch-banner-overlay">
        <span className="small-label">{placement.eyebrow || "FORE EDITORS"}</span>
        {placement.sponsored && <span className="sponsored-label">Sponsored by {placement.sponsorName || "publisher"}</span>}
        <h2>{placement.title}</h2>
        {placement.body && <p>{placement.body}</p>}
        {href && <a className="button gold" href={href} onClick={logClick}>{placement.ctaLabel || "Explore"} <ArrowRight size={17} /></a>}
      </div>
    </section>
  );
}

function TaxonomyBrowse({ taxonomy, activePath }: { taxonomy?: TaxonomyResponse; activePath?: string }) {
  if (!taxonomy?.nodes?.length) return null;
  return (
    <details className="taxonomy-browser" open={!!activePath}>
      <summary>Browse categories <ChevronDown size={16} /></summary>
      <div className="taxonomy-mega">
        {taxonomy.nodes.filter((n) => n.count > 0).map((root) => <TaxonomyBranch key={root.id} node={root} activePath={activePath} />)}
      </div>
    </details>
  );
}

export function StorePage({ landingPath = "/" }: { landingPath?: string }) {
  const { params: url, update } = useUrlSearch(landingPath);
  const routePreset = pathPreset(landingPath);
  const q = url.get("q") || url.get("search") || "";
  const [query, setQuery] = useState(q);
  const [suggestQuery, setSuggestQuery] = useState(q);
  const [searchFocused, setSearchFocused] = useState(false);
  const [visitor, setVisitor] = useState("");
  const [pageViewId, setPageViewId] = useState("");
  const storefrontPage = useQuery<StorefrontPage>({ queryKey: ["storefront-page", landingPath], queryFn: () => api("/storefront/page?path=" + encodeURIComponent(landingPath)), retry: 0 });
  const cmsPreset = storefrontPage.data?.query || {};
  const presetValue = (key: string) => (cmsPreset[key] ?? routePreset[key]);
  const presetFirst = (key: string) => Array.isArray(presetValue(key)) ? String((presetValue(key) as unknown[])[0] || "") : String(presetValue(key) || "");
  const presetTaxonomy = Array.isArray(presetValue("taxonomy")) ? String((presetValue("taxonomy") as unknown[])[0] || "") : String(presetValue("taxonomy") || "");
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
  const subscriptionOnly = url.get("subscription") === "true" || presetValue("subscription") === true;
  const libraryOnly = url.get("library") === "true" || presetValue("library") === true;
  const minRating = url.get("minRating") || String(presetValue("minRating") || "all");
  const minPrice = url.get("minPrice") || String(presetValue("minPrice") || "");
  const maxPrice = url.get("maxPrice") || String(presetValue("maxPrice") || "");
  const publishedAfter = url.get("publishedAfter") || String(presetValue("publishedAfter") || "");
  const publishedBefore = url.get("publishedBefore") || String(presetValue("publishedBefore") || "");
  const page = Math.max(1, Number(url.get("page") || 1) || 1);
  const explicitSort = url.get("sort");
  const sort = explicitSort || String(presetValue("sort") || (q ? "relevance" : "popular"));

  useEffect(() => setQuery(q), [q]);
  useEffect(() => setVisitor(visitorId()), []);
  useEffect(() => { if (typeof window !== "undefined") setPageViewId(crypto.randomUUID()); }, [landingPath, url.toString()]);
  useEffect(() => {
    const redirectTo = storefrontPage.data?.redirectTo;
    if (!redirectTo || typeof window === "undefined" || window.location.pathname === redirectTo) return;
    window.location.replace(redirectTo);
  }, [storefrontPage.data?.redirectTo]);
  useEffect(() => {
    const t = setTimeout(() => {
      const next = query.trim();
      const path = next && ["/", "/store"].includes(landingPath) ? "/search" : undefined;
      update({ q: next || null, page: null, sort: next && !explicitSort ? "relevance" : explicitSort || null }, "replace", path);
    }, 400);
    return () => clearTimeout(t);
  }, [query, explicitSort, landingPath, update]);
  useEffect(() => { const t = setTimeout(() => setSuggestQuery(query.trim()), 160); return () => clearTimeout(t); }, [query]);

  const taxonomy = useQuery<TaxonomyResponse>({ queryKey: ["storefront-taxonomy", language], queryFn: () => api("/taxonomy" + (language !== "all" ? "?language=" + encodeURIComponent(language) : "")), staleTime: 5 * 60_000, retry: 1 });
  useEffect(() => {
    const page = storefrontPage.data;
    if (!page || typeof document === "undefined" || page.redirectTo) return;
    document.title = page.seoTitle || `${page.title || "Bookstore"} | Cove`;
    const setMeta = (selector: string, attr: "name" | "rel", key: string, value: string) => {
      let el = document.head.querySelector<HTMLMetaElement | HTMLLinkElement>(selector);
      if (!el) { el = document.createElement(attr === "rel" ? "link" : "meta") as HTMLMetaElement | HTMLLinkElement; el.setAttribute(attr, key); el.setAttribute("data-fore-storefront", "1"); document.head.appendChild(el); }
      if (el instanceof HTMLLinkElement) el.href = value; else el.content = value;
    };
    if (page.seoDescription) setMeta('meta[name="description"][data-fore-storefront]', "name", "description", page.seoDescription);
    const canonicalPath = page.canonical || landingPath;
    const canonical = typeof window !== "undefined" ? new URL(canonicalPath, window.location.origin).href : canonicalPath;
    setMeta('link[rel="canonical"][data-fore-storefront]', "rel", "canonical", canonical);
    // Arbitrary filtered/search URLs remain shareable but should not explode the SEO index.
    // Curated landing/category/entity URLs without query parameters remain indexable.
    const hasUrlFilters = typeof window !== "undefined" && new URLSearchParams(window.location.search).size > 0;
    if (page.noindex || landingPath === "/search" || hasUrlFilters) setMeta('meta[name="robots"][data-fore-storefront]', "name", "robots", "noindex,follow");
    return () => { document.head.querySelectorAll('[data-fore-storefront="1"]').forEach((node) => node.remove()); };
  }, [storefrontPage.data, landingPath, url.toString()]);

  const params = new URLSearchParams({ search: q, sort, page: String(page) });
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

  const result = useQuery<CatalogResponse>({
    queryKey: ["catalog", params.toString()], queryFn: () => api("/catalog?" + params), retry: 1,
    placeholderData: !q && !taxonomyPath && page === 1 && language === "all" && format === "all" && publisher === "all" && series === "all" && !authorId && !seriesId && !publisherId && !imprintId && !deals && !preorders && !newReleases ? { results: seed.results as unknown as CatalogBook[], count: 24, next: null } : undefined,
  });
  useEffect(() => {
    const queryId=result.data?.search?.queryId;
    if(!visitor||!queryId)return;
    void api("/events","POST",{eventType:"search_performed",anonymousId:visitor,queryId,sourceSurface:landingPath||"/store",properties:{query:q,sort,resultCount:result.data?.count||0},dedupeKey:`search:${queryId}`}).catch(()=>{});
  },[result.data?.search?.queryId,visitor,landingPath,q,sort,result.data?.count]);
  const suggestions = useQuery<{ suggestions: { type: string; productId: string; bookId: string; label: string; sublabel: string }[] }>({
    queryKey: ["catalog-suggestions", suggestQuery], queryFn: () => api("/search/suggest?q=" + encodeURIComponent(suggestQuery)), enabled: searchFocused && suggestQuery.length >= 2, staleTime: 30_000, retry: 0,
  });

  const filtered = !!(q || taxonomyPath || language !== "all" || format !== "all" || publisher !== "all" || series !== "all" || authorId || seriesId || publisherId || imprintId || deals || preorders || newReleases || subscriptionOnly || libraryOnly || minRating !== "all" || minPrice || maxPrice || publishedAfter || publishedBefore);
  const home = ["/", "/store"].includes(landingPath) && !filtered && page === 1;
  const { data } = useAccount();
  const merch = useQuery<MerchResponse>({ queryKey: ["merchandising", visitor, !!data.user], queryFn: () => api(`/merchandising?visitor=${encodeURIComponent(visitor)}`), enabled: home && !!visitor, staleTime: 60_000, retry: 1 });
  const recommendations = useQuery<RecommendationResponse>({ queryKey: ["recommendations-home", visitor, data.user?.id || "anonymous"], queryFn: () => api(`/recommendations/home?visitor=${encodeURIComponent(visitor)}&limit=12`), enabled: home && !!visitor, staleTime: 5 * 60_000, retry: 1 });
  const books = result.data?.results || [];
  const current = data.library.filter((x) => x.status === "reading").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const hero = merch.data?.slots?.["home.hero"]?.[0];
  const heroBook = hero?.books?.[0];
  const heroImpressionRef = usePlacementImpression(hero, visitor, pageViewId, heroBook?.productId || null, heroBook ? 1 : undefined);
  const banners = merch.data?.slots?.["home.campaign"] || [];
  const rails = [...(merch.data?.slots?.["home.primary"] || []), ...(merch.data?.slots?.["home.secondary"] || [])];
  const heading = storefrontPage.data?.heading || (landingPath === "/search" ? "Search the bookstore" : "Find your next great read.");
  const eyebrow = storefrontPage.data?.eyebrow || "THE BOOKSTORE";
  const description = storefrontPage.data?.description || "Stories to get lost in. Ideas to carry with you.";

  function setFilter(key: string, value: string | boolean | null, mode: "push" | "replace" = "push") { update({ [key]: value, page: null }, mode); }
  function clearFilters() {
    const presetLanding = landingPath.startsWith("/ebooks/") || landingPath.startsWith("/campaign/") || landingPath.startsWith("/author/") || landingPath.startsWith("/series/") || landingPath.startsWith("/publisher/") || landingPath.startsWith("/imprint/") || ["/deals","/new-releases","/preorders","/bestsellers"].includes(landingPath);
    update({ q: null, sort: null, taxonomy: null, language: null, format: null, publisher: null, series: null, authorId: null, seriesId: null, publisherId: null, imprintId: null, deals: null, preorder: null, newRelease: null, subscription: null, library: null, minRating: null, minPrice: null, maxPrice: null, publishedAfter: null, publishedBefore: null, page: null }, "push", presetLanding ? "/store" : undefined);
  }
  function toggleLandingFilter(key: "deals" | "newRelease" | "preorder", active: boolean, activePath: string) {
    if (active && landingPath === activePath) update({ [key]: null, sort: null, page: null }, "push", "/store");
    else setFilter(key, active ? null : true);
  }
  function chooseTaxonomy(next: string) {
    if (next === "all") { update({ taxonomy: null, page: null }, "push", landingPath.startsWith("/ebooks/") ? "/store" : undefined); return; }
    if (landingPath.startsWith("/ebooks/")) update({ taxonomy: null, page: null }, "push", `/ebooks/${next}`);
    else setFilter("taxonomy", next);
  }

  return (
    <div className="store-page">
      <div className="page-eyebrow">{eyebrow} <span>{landingPath === "/" || landingPath === "/store" ? "Good books. Open to everyone." : storefrontPage.data?.title || "Browse Cove"}</span></div>
      <div className="page-heading">
        <div><h1>{heading}<span className="gold-text">.</span></h1><p>{description}</p></div>
        <a className="text-link desktop-only" href="/library">Your library <ArrowUpRight size={17} /></a>
      </div>
      {storefrontPage.data?.entity&&storefrontPage.data.pageType!=="series"&&<section className="entity-profile-card">{storefrontPage.data.entity.imageUrl&&<img src={storefrontPage.data.entity.imageUrl} alt=""/>}<div><span className="small-label">{storefrontPage.data.entity.type.toUpperCase()}</span><h2>{storefrontPage.data.entity.name}</h2>{storefrontPage.data.entity.publisherName&&<p>Part of <a href={`/publisher/${encodeURIComponent(storefrontPage.data.entity.publisherSlug||storefrontPage.data.entity.publisherId||"")}`}>{storefrontPage.data.entity.publisherName}</a></p>}{storefrontPage.data.entity.website&&<a className="text-link" href={storefrontPage.data.entity.website} target="_blank" rel="noreferrer">Official site <ArrowUpRight size={14}/></a>}{!!storefrontPage.data.entity.imprints?.length&&<div className="entity-related-block"><span className="small-label">IMPRINTS</span><div className="entity-related-links">{storefrontPage.data.entity.imprints.map(x=><a key={x.id} href={`/imprint/${encodeURIComponent(x.slug||x.id)}`}>{x.name}</a>)}</div></div>}{!!storefrontPage.data.entity.series?.length&&<div className="entity-related-block"><span className="small-label">SERIES & COLLECTIONS</span><div className="entity-related-links">{storefrontPage.data.entity.series.map(x=><a key={x.id} href={`/series/${encodeURIComponent(x.slug||x.id)}`}>{x.name}</a>)}</div></div>}</div></section>}
      {!!storefrontPage.data?.breadcrumbs?.length && (
        <nav className="store-breadcrumbs" aria-label="Breadcrumb">
          <a href="/store">eBooks</a><span aria-hidden="true">/</span>
          {storefrontPage.data.breadcrumbs.map((crumb, index) => <span key={crumb.id}>{index > 0 && <span aria-hidden="true">/</span>}<a href={crumb.href} aria-current={index === (storefrontPage.data?.breadcrumbs?.length || 0) - 1 ? "page" : undefined}>{crumb.name}</a></span>)}
        </nav>
      )}
      {!!storefrontPage.data?.children?.length && (
        <div className="subcategory-grid" aria-label={`Browse within ${storefrontPage.data.title || "this category"}`}>
          {storefrontPage.data.children.map((child) => <a key={child.id} href={child.href}><strong>{child.name}</strong>{child.description && <small>{child.description}</small>}</a>)}
        </div>
      )}

      <div className="catalog-search">
        <Search size={21} />
        <input aria-label="Search books by title, author, series, ISBN, publisher, or catalog ID" placeholder="Search titles, authors, series, ISBNs, publishers…" value={query} onFocus={() => setSearchFocused(true)} onBlur={() => setTimeout(() => setSearchFocused(false), 120)} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        {query && <button className="text-link" onClick={() => setQuery("")}>Clear</button>}
        <kbd>/</kbd>
        {searchFocused && query.trim().length >= 2 && !!suggestions.data?.suggestions?.length && (
          <div className="search-suggestions" role="listbox" aria-label="Search suggestions">
            {suggestions.data.suggestions.map((suggestion) => <a key={suggestion.productId} href={bookPath(suggestion.bookId)} role="option"><Search size={15} /><span><strong>{suggestion.label}</strong><small>{suggestion.sublabel}</small></span><ArrowUpRight size={14} /></a>)}
          </div>
        )}
      </div>

      <div className="commercial-shortcuts" aria-label="Bookstore destinations">
        <a href="/bestsellers">Bestsellers</a><a href="/new-releases">New releases</a><a href="/preorders">Coming soon</a><a href="/deals">Deals</a>
      </div>
      <TaxonomyBrowse taxonomy={taxonomy.data} activePath={taxonomyPath} />

      {home && heroBook && hero && (
        <div className="discovery-row">
          <section className="featured-book" data-placement={hero.id} ref={heroImpressionRef}>
            <div className="feature-copy">
              <span className="feature-label">{hero.eyebrow || "THE FORE EDIT"}</span>
              {hero.sponsored && <span className="sponsored-label">Sponsored by {hero.sponsorName || "publisher"}</span>}
              <h2>{hero.title || heroBook.title}</h2>
              <p>{authorOf(heroBook)}</p>
              <p className="feature-description">{hero.body || heroBook.summaries?.[0]?.slice(0, 220)}{!hero.body && (heroBook.summaries?.[0]?.length || 0) > 220 ? "…" : ""}</p>
              <a className="button gold" href={editionPath(heroBook)} onClick={() => { if (visitor && pageViewId) void api("/merchandising/event", "POST", { type: "click", placementId: hero.id, visitorId: visitor, pageViewId, productId: heroBook.productId || null, position: 1 }).catch(() => {}); }}>{hero.ctaLabel || "Open this book"} <ArrowRight size={17} /></a>
            </div>
            <a href={editionPath(heroBook)} className="feature-cover" onClick={() => { if (visitor && pageViewId) void api("/merchandising/event", "POST", { type: "click", placementId: hero.id, visitorId: visitor, pageViewId, productId: heroBook.productId || null, position: 1 }).catch(() => {}); }}><BookArt book={heroBook} /></a>
          </section>
          <section className="reading-callout">
            <span className="small-label">{current ? "PICK UP WHERE YOU LEFT OFF" : "MAKE ROOM FOR READING"}</span><BookOpen size={27} strokeWidth={1.3} />
            <h2>{current ? current.book.title : "A little reading.\nA world of possibility."}</h2>
            <p>{current ? `${Math.round(current.progress * 100)}% read · ${authorOf(current.book)}` : "Your books, best passages, and new words. All in one place."}</p>
            <a className="text-link" href={current ? readPath(current.bookId) : "/library"}>{current ? "Continue reading" : "Explore your library"} <ArrowRight size={17} /></a>
          </section>
        </div>
      )}

      {home && banners.map((placement) => <MerchBanner key={placement.id} placement={placement} visitor={visitor} pageViewId={pageViewId} />)}
      {home && rails.map((placement) => <MerchRail key={placement.id} placement={placement} visitor={visitor} pageViewId={pageViewId} />)}
      {home && (recommendations.data?.rails || []).map((rail) => <RecommendationRailView key={`${rail.key}:${rail.requestId}`} rail={rail} visitor={visitor} />)}

      <div className="catalog-controls">
        <div className="topic-tabs" role="group" aria-label="Featured book categories">
          <a className={!taxonomyPath ? "active" : ""} href="/store">All books</a>
          {(taxonomy.data?.featured || []).slice(0, 9).map((node) => <a key={node.id} href={node.href} className={taxonomyPath === node.path ? "active" : ""}>{node.name}</a>)}
        </div>
        <div className="filter-row">
          <span className="catalog-count">{result.isFetching ? "Finding books…" : `${result.data?.count?.toLocaleString() || 0} books`}{result.data?.ingestion?.status === "running" && <small> · Catalog updating</small>}</span>
          <div className="filter-selects">
            <Select value={language} onValueChange={(v) => setFilter("language", v === "all" ? null : v)}><SelectTrigger aria-label="Book language"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All languages</SelectItem>{(result.data?.facets?.languages || []).slice(0, 40).map((x) => <SelectItem key={x.value} value={x.value}>{x.value.toUpperCase()} ({x.count})</SelectItem>)}</SelectContent></Select>
            <Select value={format} onValueChange={(v) => setFilter("format", v === "all" ? null : v)}><SelectTrigger aria-label="Book format"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All formats</SelectItem>{(result.data?.facets?.formats || []).map((x) => <SelectItem key={x.value} value={x.value}>{x.value} ({x.count})</SelectItem>)}</SelectContent></Select>
            <Select value={sort} onValueChange={(v) => update({ sort: v, page: null }, "push")}><SelectTrigger aria-label="Sort books"><SlidersHorizontal size={15} /><SelectValue /></SelectTrigger><SelectContent>
              {q && <SelectItem value="relevance">Best match</SelectItem>}<SelectItem value="bestselling">Bestselling on Cove</SelectItem><SelectItem value="trending">Trending on Cove</SelectItem><SelectItem value="most_read">Most read</SelectItem><SelectItem value="most_wishlisted">Most wishlisted</SelectItem><SelectItem value="noteworthy">New & noteworthy</SelectItem><SelectItem value="top_rated">Top rated</SelectItem><SelectItem value="released">Recently released</SelectItem><SelectItem value="published">Recently published</SelectItem><SelectItem value="added">Recently added to Cove</SelectItem><SelectItem value="updated">Recently updated</SelectItem><SelectItem value="coming_soon">Coming soon</SelectItem><SelectItem value="price_asc">Price: low to high</SelectItem><SelectItem value="price_desc">Price: high to low</SelectItem><SelectItem value="title">Title A–Z</SelectItem>
            </SelectContent></Select>
          </div>
        </div>
      </div>

      <div className="search-facets" aria-label="Search filters">
        <Select value={taxonomyPath || "all"} onValueChange={chooseTaxonomy}><SelectTrigger aria-label="Retail category"><SelectValue placeholder="Category" /></SelectTrigger><SelectContent><SelectItem value="all">All categories</SelectItem>{flattenTaxonomy(taxonomy.data?.nodes || []).filter((x) => x.count > 0).map((x) => <SelectItem key={x.id} value={x.path}>{x.depth ? `${"—".repeat(Math.min(x.depth, 3))} ` : ""}{x.name} ({x.count})</SelectItem>)}</SelectContent></Select>
        <Select value={publisher} onValueChange={(v) => setFilter("publisher", v === "all" ? null : v)}><SelectTrigger aria-label="Publisher"><SelectValue placeholder="Publisher" /></SelectTrigger><SelectContent><SelectItem value="all">All publishers</SelectItem>{(result.data?.facets?.publishers || []).slice(0, 30).map((x) => <SelectItem key={x.value} value={x.value}>{x.value} ({x.count})</SelectItem>)}</SelectContent></Select>
        <Select value={series} onValueChange={(v) => setFilter("series", v === "all" ? null : v)}><SelectTrigger aria-label="Series"><SelectValue placeholder="Series" /></SelectTrigger><SelectContent><SelectItem value="all">All series</SelectItem>{(result.data?.facets?.series || []).slice(0, 30).map((x) => <SelectItem key={x.value} value={x.value}>{x.value} ({x.count})</SelectItem>)}</SelectContent></Select>
        <button className={deals ? "facet-toggle active" : "facet-toggle"} onClick={() => toggleLandingFilter("deals", deals, "/deals")}>Deals</button>
        <button className={newReleases ? "facet-toggle active" : "facet-toggle"} onClick={() => toggleLandingFilter("newRelease", newReleases, "/new-releases")}>New releases</button>
        <button className={preorders ? "facet-toggle active" : "facet-toggle"} onClick={() => toggleLandingFilter("preorder", preorders, "/preorders")}>Preorders</button>
        <button className={subscriptionOnly ? "facet-toggle active" : "facet-toggle"} onClick={() => setFilter("subscription", subscriptionOnly ? null : true)}>Subscription</button>
        <button className={libraryOnly ? "facet-toggle active" : "facet-toggle"} onClick={() => setFilter("library", libraryOnly ? null : true)}>Library eligible</button>
        <Select value={minRating} onValueChange={(v) => setFilter("minRating", v === "all" ? null : v)}><SelectTrigger aria-label="Minimum rating"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Any rating</SelectItem><SelectItem value="4">4★ & up</SelectItem><SelectItem value="3">3★ & up</SelectItem><SelectItem value="2">2★ & up</SelectItem></SelectContent></Select>
        <label className="facet-field"><span>Min $</span><input inputMode="decimal" aria-label="Minimum price" value={minPrice} onChange={(e) => setFilter("minPrice", e.target.value.replace(/[^0-9.]/g, ""), "replace")} placeholder="0" /></label>
        <label className="facet-field"><span>Max $</span><input inputMode="decimal" aria-label="Maximum price" value={maxPrice} onChange={(e) => setFilter("maxPrice", e.target.value.replace(/[^0-9.]/g, ""), "replace")} placeholder="Any" /></label>
        <label className="facet-field date"><span>Published after</span><input type="date" aria-label="Published after" value={publishedAfter} onChange={(e) => setFilter("publishedAfter", e.target.value)} /></label>
        <label className="facet-field date"><span>Before</span><input type="date" aria-label="Published before" value={publishedBefore} onChange={(e) => setFilter("publishedBefore", e.target.value)} /></label>
        {filtered && <button className="text-link" onClick={clearFilters}>Clear filters</button>}
      </div>

      {result.data?.search?.correctedQuery && <p className="search-correction">Showing results for <strong>{result.data.search.correctedQuery}</strong>.</p>}
      {result.data?.warning && <p className="notice">{result.data.warning}</p>}
      {result.error ? <div className="empty-state"><h2>The catalog needs a moment.</h2><p>{result.error.message}</p><button className="button gold" onClick={() => result.refetch()}>Try again</button></div>
        : result.isLoading ? <div className="book-grid">{Array.from({ length: 12 }, (_, i) => <div key={i}><Skeleton className="aspect-[2/3] w-full rounded-sm" /><Skeleton className="mt-4 h-5 w-4/5" /></div>)}</div>
        : books.length ? <div className="book-grid">{books.map((b, index) => <BookCard key={String(b.productId || b.id)} book={b} onOpen={() => { const queryId = result.data?.search?.queryId; const position=(page - 1) * (result.data?.search?.pageSize || 24) + index + 1; if (queryId && b.productId) { void api("/search/click", "POST", { queryId, productId: b.productId, position }).catch(() => {}); if(visitor) void api("/events","POST",{eventType:"search_result_clicked",anonymousId:visitor,productId:b.productId,externalBookId:String(b.sourceExternalId||b.id),queryId,sourceSurface:landingPath||"/store",properties:{position},dedupeKey:`search-click:${queryId}:${b.productId}:${position}`}).catch(()=>{}); } }} />)}</div>
        : <div className="empty-state"><Search /><h2>No books found</h2><p>Try an author’s surname, a shorter title, or another category.</p><button className="button outline" onClick={clearFilters}>Clear filters</button></div>}

      {!result.isLoading && books.length > 0 && <div className="pagination"><button className="button outline" disabled={page === 1} onClick={() => { update({ page: Math.max(1, page - 1) }, "push"); window.scrollTo({ top: 0, behavior: "smooth" }); }}><ChevronLeft size={17} /> Previous</button><span>Page {page}</span><button className="button outline" disabled={!result.data?.next} onClick={() => { update({ page: page + 1 }, "push"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Next <ChevronRight size={17} /></button></div>}

      <footer className="site-footer"><span>FORE <span className="muted">· Read something that stays with you.</span></span><a href="/publishing-policy">Publishing & AI policy</a><a href="/copyright">Copyright / DMCA</a><a href="https://www.gutenberg.org" target="_blank" rel="noreferrer">Federated Gutenberg sources <ArrowUpRight size={13} /></a><span>Availability follows the public-domain determination for your storefront country.</span></footer>
    </div>
  );
}
