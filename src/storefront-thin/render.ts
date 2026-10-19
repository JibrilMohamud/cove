import type { CatalogBook } from "../features/fore/client";
import type { StorefrontBootstrap } from "../features/fore/storefront-bootstrap";
import { formatMinorCurrency } from "../features/fore/currency";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const localCovers = new Set("1342 2701 1661 2641 11 345 1260 84 2852 64317 768 2591 74 98 174 5200 2600 16 4300 120 1400 205 1080 46".split(" "));
export function thinBookPath(book: CatalogBook) {
  if (book.publicEditionId || book.editionId)
    return "/edition/" + encodeURIComponent(book.publicEditionId || book.editionId!);
  const ref = String(book.publicProductId || book.id);
  return (book.publicProductId || ref.startsWith("prd_") ? "/books/" : "/book/") + encodeURIComponent(ref);
}
export function thinCover(book: CatalogBook) {
  const ref = String(book.sourceExternalId ?? book.id);
  const raw = localCovers.has(ref) ? `/covers/${ref}.jpg` : book.formats?.["image/jpeg"] || book.formats?.["image/png"] || "";
  // Metadata never becomes executable markup, even on an isolated experiment.
  if (/^\/(?!\/)/.test(raw) || /^https:\/\//i.test(raw)) return raw;
  return "";
}
function authorName(name: string) {
  const p = name.split(",");
  return p.length > 1 ? `${p.slice(1).join(",").trim()} ${p[0]}` : name;
}
function card(book: CatalogBook, index: number) {
  const href = escape(thinBookPath(book));
  const cover = thinCover(book);
  const authors = book.authors?.map((a) => a.id
    ? `<a href="/author/${escape(encodeURIComponent(a.slug || a.id))}">${escape(authorName(a.name))}</a>`
    : escape(authorName(a.name))).join(", ") || "Unknown author";
  const price = !book.offer ? "Unavailable" : Number(book.offer.amountMinor || 0) === 0 ? "Free"
    : formatMinorCurrency(Number(book.offer.amountMinor || 0), book.offer.currency || "USD");
  const genre = (book.bookshelves?.[0] || book.subjects?.[0] || "Literature").replace(/^.*?: /, "").split(" -- ")[0];
  return `<article class="book-card" data-product="${escape(book.productId)}"><a class="cover" href="${href}">${cover ? `<img src="${escape(cover)}" alt="${escape("Cover of " + book.title)}" width="240" height="360" loading="${index < 4 ? "eager" : "lazy"}" fetchpriority="${index === 0 ? "high" : "auto"}">` : `<span class="cover-fallback">${escape(book.title)}</span>`}</a><p class="genre">${escape(genre)}</p><h3><a class="book-title" href="${href}">${escape(book.title)}</a></h3><p>${authors}</p><p>${escape(price)} <small>EPUB</small></p><a href="${href}">Explore book<span class="sr-only">: ${escape(book.title)}</span></a></article>`;
}

/** No framework runtime, serialized grant, hydration payload, or shared HTML cache. */
export function renderThinStorefront(bootstrap: StorefrontBootstrap, origin: string) {
  const { context, catalog, page } = bootstrap;
  const title = page.title || "Discover your next great read";
  const description = page.description || "Good books. Open to everyone.";
  const canonical = new URL("/", origin).href;
  return `<!doctype html><html lang="${escape(context.locale)}" dir="${context.direction === "rtl" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Cove</title><meta name="description" content="${escape(description)}"><link rel="canonical" href="${escape(canonical)}"><style>
*{box-sizing:border-box}body{margin:0;background:#fcfaf5;color:#242922;font:16px/1.6 system-ui,sans-serif}a{color:inherit}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid #76561c;outline-offset:4px}.skip{position:absolute;top:-60px}.skip:focus{top:0;background:white;padding:12px}header,main,footer{max-width:1240px;margin:auto;padding:24px}header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ddd4c5}nav{display:flex;gap:20px;flex-wrap:wrap}.logo{font:36px Georgia,serif;text-decoration:none}h1{font:clamp(34px,6vw,64px)/1.1 Georgia,serif;max-width:800px;margin:36px 0 16px}h2{font:30px Georgia,serif}form{display:flex;gap:10px;margin:28px 0}input{padding:14px;border:1px solid #8c897c;background:white;border-radius:5px;min-width:0;flex:1;max-width:650px;font:inherit}button{padding:12px 22px;background:#303c32;color:white;border:0;border-radius:5px;font:inherit}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:32px 24px}.book-card{min-width:0}.cover{height:270px;display:flex;align-items:center;justify-content:center;background:#eee7d8;border-radius:8px;padding:18px}.cover img{width:156px;height:234px;object-fit:contain}.cover-fallback{font:24px Georgia,serif;text-align:center;max-width:180px}.genre{font-size:12px;color:#645b49;margin-bottom:0}h3{font:21px/1.3 Georgia,serif;margin:8px 0}h3 a{text-decoration:none}.book-card p{margin:7px 0}small{color:#645b49}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}footer{margin-top:48px;border-top:1px solid #ddd4c5}@media(max-width:800px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.cover{height:230px;padding:10px}.cover img{width:132px;height:198px}header,main,footer{padding:18px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style></head><body><a class="skip" href="#main">Skip to books</a><header><a class="logo" href="/">Cove</a><nav aria-label="Main"><a href="/store">Browse</a><a href="/library">My library</a><a href="/account">Account</a></nav></header><main id="main"><h1>${escape(title)}</h1><p>${escape(description)}</p><p>Storefront: ${escape(context.storefrontCountry)} · ${escape(context.currency)}</p><form action="/store" method="get" role="search"><label class="sr-only" for="search">Search books</label><input id="search" name="search" type="search" placeholder="Search titles and authors"><button>Search</button></form><nav aria-label="Collections"><a href="/bestsellers">Bestsellers</a><a href="/new-releases">New releases</a><a href="/preorders">Coming soon</a><a href="/deals">Deals</a></nav><h2>Explore eBooks</h2><div class="grid" data-rights-country="${escape(context.rightsCountry)}">${catalog.results.map(card).join("")}</div><p><a href="/store">Browse all books and filters</a></p><section aria-labelledby="discovery-title"><h2 id="discovery-title">What would you love to read next?</h2><p><a href="/store#literary-discovery-title">Find books with literary discovery</a></p></section></main><footer><nav aria-label="Policies"><a href="/publishing-policy">Publishing &amp; AI policy</a><a href="/copyright">Copyright / DMCA</a><a href="/privacy">Privacy</a></nav></footer></body></html>`;
}
