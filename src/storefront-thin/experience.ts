import type { StorefrontBootstrap } from "../features/fore/storefront-bootstrap";

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/**
 * The original React/account/reader bundle is never imported. Offers and the
 * first shelf are the same primary-rights-checked bootstrap as in full SSR.
 * Interactive, authenticated and filtered journeys are handled by CORE.
 */
export function renderThinExperience(
  bootstrap: StorefrontBootstrap,
  origin: string,
  cardsMarkup: string,
) {
  const { context, page } = bootstrap;
  const headline = page.heading || page.title || "Find your next great read";
  const eyebrow = page.eyebrow || "THE BOOKSTORE";
  const description = page.description || "Stories to get lost in. Ideas to carry with you.";
  const market = context.availableMarkets.find((x) => x.countryCode === context.storefrontCountry);
  const locales = market?.locales?.length ? market.locales : [context.locale];
  const options = locales
    .map(
      (locale) =>
        `<option value="${escape(locale)}"${locale === context.locale ? " selected" : ""}>${escape(locale)}</option>`,
    )
    .join("");
  const nav = [
    ["/", "Bookstore"],
    ["/audiobooks", "Audiobooks"],
    ["/library", "My library"],
    ["/wishlist", "Wishlist"],
    ["/cart", "Cart"],
    ["/orders", "Orders"],
    ["/notifications", "Notifications"],
    ["/community", "Community"],
    ["/shelves", "Shelves"],
    ["/stats", "Stats"],
    ["/highlights", "Highlights & notes"],
    ["/definitions", "Word collection"],
    ["/downloads", "Downloads"],
    ["/publishing", "Cove Publishing"],
    ["/help", "Help & support"],
  ]
    .map(
      ([href, label]) =>
        `<a href="${href}"${href === "/" ? ' aria-current="page" class="active"' : ""}>${escape(label)}</a>`,
    )
    .join("");

  // No data-derived script content or inline handlers. All data is inserted
  // with HTML escaping above, and API response text uses only textContent.
  const behavior = `
const byId = (id) => document.getElementById(id);
function visitorId() {
  const key = "fore:merch-visitor:v1";
  try {
    let value = localStorage.getItem(key) || "";
    if (!/^[0-9a-f-]{36}$/i.test(value)) {
      value = crypto.randomUUID();
      localStorage.setItem(key, value);
    }
    return value;
  } catch {
    return crypto.randomUUID();
  }
}
const visitor = visitorId();
const language = byId("thin-locale");
language?.addEventListener("change", async () => {
  const status = byId("thin-locale-status");
  status.textContent = "Updating storefront language…";
  try {
    const response = await fetch("/api/fore/storefront/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ locale: language.value }),
    });
    if (!response.ok) throw new Error("Locale update unavailable");
    location.assign("/?storefront=full");
  } catch {
    status.textContent = "Could not update storefront language. Open the full bookstore to retry.";
  }
});
for (const select of document.querySelectorAll("[data-thin-filter]")) {
  select.addEventListener("change", () => {
    const key = select.getAttribute("data-thin-filter");
    const value = select.value;
    const url = new URL("/store", location.origin);
    if (value && value !== "all") url.searchParams.set(key, value);
    location.assign(url.href);
  });
}
const discovery = byId("thin-discovery-form");
const discoveryResult = byId("thin-discovery-results");
const discoveryStatus = byId("thin-discovery-status");
const terms = (id) =>
  String(byId(id)?.value || "").split(",").map((s) => s.trim()).filter(Boolean);
function safeBookHref(book) {
  const id = book.publicEditionId || book.editionId;
  if (typeof id !== "string" || !/^[a-z0-9_-]{1,160}$/i.test(id)) return null;
  return "/edition/" + encodeURIComponent(id);
}
discovery?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = discovery.querySelector('button[type="submit"]');
  submit.disabled = true;
  discoveryStatus.textContent = "Finding books…";
  discoveryResult.replaceChildren();
  try {
    const response = await fetch(
      "/api/fore/recommendations/discover?visitor=" + encodeURIComponent(visitor),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          query: String(byId("thin-discovery-query")?.value || "").slice(0, 500),
          controls: {
            likes: terms("thin-discovery-likes"),
            dislikes: terms("thin-discovery-dislikes"),
            maxMinutes: byId("thin-discovery-minutes").value
              ? Number(byId("thin-discovery-minutes").value)
              : null,
            adventurousness: Number(byId("thin-discovery-adventure").value),
            languages: [],
          },
        }),
      },
    );
    if (!response.ok) throw new Error("Discovery request failed");
    const payload = await response.json();
    let count = 0;
    for (const rail of Array.isArray(payload.rails) ? payload.rails : []) {
      const section = document.createElement("section");
      const heading = document.createElement("h3");
      heading.textContent = String(rail.title || "Recommended books");
      section.append(heading);
      const list = document.createElement("div");
      list.className = "thin-recommendations";
      for (const book of Array.isArray(rail.books) ? rail.books : []) {
        const href = safeBookHref(book);
        if (!href) continue;
        const link = document.createElement("a");
        link.href = href;
        link.textContent = String(book.title || "Explore book");
        list.append(link);
        count++;
      }
      section.append(list);
      discoveryResult.append(section);
    }
    discoveryStatus.textContent = count
      ? count + " evidence-grounded book suggestions"
      : String(payload.emptyReason || "No recommendations yet. Try another theme.");
  } catch {
    discoveryStatus.textContent = "Discovery is unavailable. Open the full bookstore to retry.";
  } finally {
    submit.disabled = false;
  }
});
discovery?.addEventListener("reset", () => {
  discoveryResult.replaceChildren();
  discoveryStatus.textContent = "Form cleared.";
});
const merch = byId("thin-merchandising");
let merchRequested = false;
async function loadMerchandising() {
  if (merchRequested) return;
  merchRequested = true;
  try {
    const response = await fetch(
      "/api/fore/merchandising?visitor=" + encodeURIComponent(visitor),
      { credentials: "same-origin" },
    );
    if (!response.ok) return;
    const payload = await response.json();
    const slots = payload.slots || {};
    const placements = Object.values(slots).flat().slice(0, 8);
    for (const placement of placements) {
      const section = document.createElement("section");
      section.className = "thin-placement";
      const label = document.createElement("p");
      label.textContent = String(placement.eyebrow || "FEATURED ON COVE");
      section.append(label);
      const h = document.createElement("h3");
      h.textContent = String(placement.title || "Featured reading");
      section.append(h);
      if (placement.body) {
        const body = document.createElement("p");
        body.textContent = String(placement.body);
        section.append(body);
      }
      const href = String(placement.ctaHref || "/store");
      if (href.startsWith("/") && !href.startsWith("//")) {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = String(placement.ctaLabel || "Explore");
        section.append(link);
      }
      merch.append(section);
    }
  } catch {
    // Optional merchandising never blocks the mandatory live-rights shelf.
  }
}
if (merch) {
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void loadMerchandising();
      }
    }, { rootMargin: "600px 0px" });
    observer.observe(merch);
  } else {
    void loadMerchandising();
  }
}
let installPrompt = null;
const installButton = byId("thin-install");
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
});
installButton?.addEventListener("click", async () => {
  if (!installPrompt) {
    location.assign("/downloads");
    return;
  }
  await installPrompt.prompt();
  installPrompt = null;
});
`;
  const canonical = new URL("/", origin).href;
  return `<!doctype html><html lang="${escape(context.locale)}" dir="${context.direction === "rtl" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(page.seoTitle || headline)} | Cove</title><meta name="description" content="${escape(page.seoDescription || description)}"><link rel="canonical" href="${escape(canonical)}"><style>
:root{--background:#0e1725;--foreground:#eceeea;--muted:#a1adbe;--gold:#e6c17a;--border:#2a3648;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:16px/1.55 Inter,Arial,sans-serif}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
a:focus-visible,input:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
.skip{position:fixed;top:-100px;left:10px;background:var(--gold);color:#071426;padding:12px;z-index:10}.skip:focus{top:0}
.fore-app{min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:236px;background:#111c2c;border-right:1px solid var(--border);display:flex;flex-direction:column;padding:32px 20px}.logo{font:44px Georgia,serif;color:#f1eddf;letter-spacing:-2px}.logo span{color:var(--gold)}.nav-label{font-size:11px;letter-spacing:1.5px;color:#8290a5;margin:35px 12px 14px}.main-nav{display:flex;flex-direction:column;gap:4px}.main-nav a{padding:9px 12px;border-radius:6px;color:#a5b1c3;font-size:13px}.main-nav a.active{color:#f1d29b;background:#e5c48714}.sidebar-bottom{margin-top:auto;padding-top:16px;border-top:1px solid var(--border);font:18px Georgia,serif;color:#a0abba}.main-shell{margin-left:236px}.topbar{display:flex;gap:14px;justify-content:space-between;align-items:center;padding:18px 40px;border-bottom:1px solid var(--border);min-height:76px}.topbar nav{display:flex;gap:14px;flex-wrap:wrap}.topbar a{font-size:13px}.content{max-width:1600px;margin:auto;padding:34px 40px}.eyebrow{font-size:11px;letter-spacing:1.7px;color:var(--gold)}.eyebrow span{letter-spacing:normal;color:#8796a8}.heading{display:flex;justify-content:space-between;align-items:end;gap:22px;margin:20px 0}.heading h1{font:clamp(36px,5vw,60px)/1.1 Georgia,serif;max-width:720px}.heading h1 span{color:var(--gold)}.heading p{color:#a4b0c0;margin:14px 0 0}.button,button{cursor:pointer;border-radius:4px;border:1px solid #3a4656;padding:10px 15px;background:#203046;color:#edf0f2;font:inherit}.button.gold,button.gold{background:var(--gold);color:#15202d}.catalog-search{display:flex;gap:10px;margin:26px 0 12px}.catalog-search input{max-width:800px;flex:1}.commercial-shortcuts{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 28px;font-size:13px}.commercial-shortcuts a{color:#e0c38e}.catalog-controls,.filter-row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.catalog-controls{border-top:1px solid var(--border);padding-top:18px;margin:18px 0}.topic-tabs{display:flex;gap:16px;flex-wrap:wrap}.topic-tabs a{font-size:13px}.filter-row{margin-bottom:14px;color:#a6b3c1}.filter-row select{max-width:220px}.filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}.filters a{border:1px solid #3a4656;border-radius:5px;padding:7px 12px;font-size:12px}.book-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:26px 22px}.book-card{min-width:0}.book-card .cover{display:flex;align-items:center;justify-content:center;height:280px;background:#2d4051;border:1px solid #35485a;padding:14px}.book-card img{object-fit:contain;max-height:240px;max-width:100%;height:auto;width:auto}.cover-fallback{font:19px Georgia,serif;text-align:center;color:#f1d29b}.genre{color:#e0c38e;font-size:11px;text-transform:uppercase;letter-spacing:.5px}.book-card h3{font:18px/1.25 Georgia,serif;margin:9px 0}.book-card p{margin:7px 0;color:#d0d9e3;font-size:13px}.book-card small{color:#9eaec0}.book-card>a:not(.cover){color:#e0c38e;font-size:12px}.pagination,.thin-placement{border-top:1px solid var(--border);padding:24px 0;margin-top:28px}.thin-placement h3{font:26px Georgia,serif}.thin-placement p{color:#a4b0c0}.thin-placement a{color:var(--gold)}.discovery{border-top:1px solid var(--border);margin-top:35px;padding-top:27px}.discovery h2{font:30px Georgia,serif}.discovery p{color:#a1adbe}.discovery form{display:grid;gap:12px;max-width:800px;margin-top:14px}.discovery label{display:grid;gap:4px}.discovery .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.discovery .actions{display:flex;gap:10px;flex-wrap:wrap}.thin-recommendations{display:flex;flex-wrap:wrap;gap:12px}.thin-recommendations a{padding:12px;border:1px solid var(--border)}input,select{background:#1a2739;color:#edf0f2;border:1px solid #3a4656;border-radius:4px;padding:10px;min-width:0;font:inherit}.locale{display:flex;align-items:center;gap:7px;font-size:12px}.locale select{padding:5px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}footer{border-top:1px solid var(--border);margin-top:38px;padding-top:20px;font-size:12px;color:#a1adbe;display:flex;gap:18px;flex-wrap:wrap}.mobile-menu{display:none}
@media(max-width:1180px){.book-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.topbar,.content{padding-left:25px;padding-right:25px}}
@media(max-width:800px){.sidebar{display:none}.main-shell{margin-left:0}.topbar,.content{padding:14px 16px}.topbar{min-height:48px}.book-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.book-card .cover{height:185px;padding:8px}.book-card h3{font-size:16px}.heading h1{font-size:36px}.heading{display:block}.heading p{font-size:13px}.mobile-menu{display:block}.mobile-menu nav{display:flex;flex-direction:column;gap:12px;padding:8px}.topbar nav{gap:8px}.discovery .two{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style></head><body><a class="skip" href="#main">Skip to books</a><div class="fore-app"><aside class="sidebar"><a class="logo" href="/">Cove<span>.</span></a><p class="nav-label">DISCOVER</p><nav class="main-nav" aria-label="Main">${nav}</nav><div class="sidebar-bottom">Find your next great read.</div></aside><div class="main-shell"><header class="topbar"><div><strong>Cove</strong> / Bookstore</div><nav aria-label="Account"><a href="/?storefront=full&amp;auth=login">Sign in</a><a class="button gold" href="/?storefront=full&amp;auth=signup">Create account</a></nav><details class="mobile-menu"><summary>Menu</summary><nav aria-label="Mobile">${nav}</nav></details><label class="locale">Storefront language<select id="thin-locale" aria-label="Storefront language">${options}</select></label><span id="thin-locale-status" role="status" class="sr-only"></span></header><main id="main" class="content"><div class="eyebrow">${escape(eyebrow)} <span>Good books. Open to everyone.</span></div><div class="heading"><div><h1>${escape(headline)}<span>.</span></h1><p>${escape(description)}</p></div><a href="/library">Your library ↗</a></div><form class="catalog-search" action="/search" method="get" role="search"><label class="sr-only" for="thin-search">Search books by title, author, series, ISBN, publisher, or catalog ID</label><input id="thin-search" type="search" name="q" placeholder="Search titles, authors, series, ISBNs, publishers…"><button type="submit">Search</button></form><nav class="commercial-shortcuts" aria-label="Bookstore destinations"><a href="/bestsellers">Bestsellers</a><a href="/new-releases">New releases</a><a href="/preorders">Coming soon</a><a href="/deals">Deals</a></nav><div class="catalog-controls"><nav class="topic-tabs" aria-label="Featured book categories"><a href="/store">All books</a><a href="/ebooks">Categories</a><a href="/trending">Trending</a><a href="/top-rated">Top rated</a></nav><span>Books available to read</span></div><div class="filter-row"><span>${bootstrap.catalog.results.length} currently available editions</span><div><label>Sort books <select data-thin-filter="sort" aria-label="Sort books"><option value="popular">Popular</option><option value="bestselling">Bestselling on Cove</option><option value="released">Recently released</option><option value="price_asc">Price: low to high</option><option value="title">Title A–Z</option></select></label></div></div><nav class="filters" aria-label="Search filters"><a href="/store">More filters</a><a href="/deals">Deals</a><a href="/new-releases">New releases</a><a href="/preorders">Preorders</a><a href="/store?subscription=true">Subscription</a><a href="/store?library=true">Library eligible</a></nav><div class="book-grid" data-rights-country="${escape(context.rightsCountry)}">${cardsMarkup}</div><div class="pagination"><a href="${escape(bootstrap.catalog.next || "/store")}" aria-label="Next page">Next page ↗</a></div><div id="thin-merchandising" aria-label="Featured storefront campaigns"></div><section class="discovery" aria-labelledby="literary-discovery-title"><h2 id="literary-discovery-title">What would you love to read next?</h2><p>Explore by theme, mood, style or setting. Results use available book evidence.</p><form id="thin-discovery-form"><label for="thin-discovery-query">For this search<input id="thin-discovery-query" maxlength="500" placeholder="mystery, reflective, less violence"></label><div class="two"><label for="thin-discovery-likes">More of (comma-separated)<input id="thin-discovery-likes" maxlength="1000" placeholder="friendship, witty"></label><label for="thin-discovery-dislikes">Avoid known themes or styles<input id="thin-discovery-dislikes" maxlength="1000" placeholder="war, melancholic"></label><label for="thin-discovery-minutes">Maximum reading time in minutes<input id="thin-discovery-minutes" type="number" min="5" max="10000" placeholder="Any length"></label><label for="thin-discovery-adventure">Discovery adventure<input id="thin-discovery-adventure" type="range" min="0" max="1" step="0.1" value="0.3"></label></div><p>Avoid filters exclude books tagged with those terms; incomplete profiles may have unrecorded content.</p><div class="actions"><button type="submit" class="gold">Discover books</button><button type="reset">Clear preferences</button><a class="button" href="/?storefront=full#literary-discovery-title">Full literary discovery</a></div></form><p id="thin-discovery-status" role="status" aria-live="polite"></p><div id="thin-discovery-results"></div></section><section class="thin-placement"><h3>Read anywhere</h3><p>Keep your library and reading tools close, online or offline.</p><button id="thin-install" type="button">Install Cove</button><a href="/downloads">Offline reading and downloads</a></section><footer><span>Cove · Read something that stays with you.</span><a href="/publishing-policy">Publishing &amp; AI policy</a><a href="/copyright">Copyright / DMCA</a><a href="/privacy">Privacy</a><span>Availability follows the rights determination for your storefront country.</span></footer></main></div></div><script type="module">${behavior}</script></body></html>`;
}
