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
export function renderStranglerExperience(
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
const search = byId("thin-search");
const suggestions = byId("thin-search-suggestions");
let suggestionTimer = null;
let activeSuggest = null;
const hideSuggestions = () => {
  suggestions.hidden = true;
  suggestions.replaceChildren();
  search?.setAttribute("aria-expanded", "false");
};
search?.addEventListener("input", () => {
  clearTimeout(suggestionTimer);
  activeSuggest?.abort();
  hideSuggestions();
  const q = search.value.trim().slice(0, 100);
  if (q.length < 2) return;
  suggestionTimer = setTimeout(async () => {
    const controller = new AbortController();
    activeSuggest = controller;
    try {
      const response = await fetch("/api/fore/search/suggest?q=" + encodeURIComponent(q), {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok || search.value.trim() !== q) return;
      const data = await response.json();
      for (const suggestion of (Array.isArray(data.suggestions) ? data.suggestions : []).slice(0, 8)) {
        if (typeof suggestion.label !== "string") continue;
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "option");
        button.textContent = suggestion.label + (suggestion.sublabel ? " — " + String(suggestion.sublabel) : "");
        button.addEventListener("click", () => {
          search.value = suggestion.label;
          hideSuggestions();
          search.form?.requestSubmit();
        });
        suggestions.append(button);
      }
      if (suggestions.childElementCount) {
        suggestions.hidden = false;
        search.setAttribute("aria-expanded", "true");
      }
    } catch {
      // Autocomplete is optional; normal search always remains available.
    }
  }, 200);
});
search?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideSuggestions();
});
for (const button of document.querySelectorAll("[data-thin-save-id]")) {
  button.addEventListener("click", async () => {
    const bookId = button.getAttribute("data-thin-save-id");
    const href = button.getAttribute("data-thin-edition-href");
    button.disabled = true;
    try {
      const response = await fetch("/api/fore/library", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookId }),
      });
      if (response.ok) {
        button.textContent = "Added to library";
        return;
      }
      if (response.status === 401 || response.status === 403) {
        location.assign("/?storefront=full&auth=login");
        return;
      }
      throw new Error("Save requires the full edition flow");
    } catch {
      location.assign(href || "/library");
    } finally {
      button.disabled = false;
    }
  });
}
for (const button of document.querySelectorAll("[data-thin-href]")) {
  button.addEventListener("click", () => {
    const href = button.getAttribute("data-thin-href");
    if (href && href.startsWith("/") && !href.startsWith("//")) location.assign(href);
  });
}
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
  return `<!doctype html><html data-theme="dark" class="dark" lang="${escape(context.locale)}" dir="${context.direction === "rtl" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(page.seoTitle || headline)} | Cove</title><meta name="description" content="${escape(page.seoDescription || description)}"><link rel="canonical" href="${escape(canonical)}"><style>
:root{--background:#0e1725;--foreground:#eceeea;--muted:#a1adbe;--gold:#e6c17a;--border:#2a3648;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:16px/1.55 Inter,Arial,sans-serif}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
a:focus-visible,input:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
.skip{position:fixed;top:-100px;left:10px;background:var(--gold);color:#071426;padding:12px;z-index:10}.skip:focus{top:0}
.fore-app{min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:236px;background:#111c2c;border-right:1px solid var(--border);display:flex;flex-direction:column;padding:32px 20px}.logo{font:44px Georgia,serif;color:#f1eddf;letter-spacing:-2px}.logo span{color:var(--gold)}.nav-label{font-size:11px;letter-spacing:1.5px;color:#8290a5;margin:35px 12px 14px}.main-nav{display:flex;flex-direction:column;gap:4px}.main-nav a{padding:9px 12px;border-radius:6px;color:#a5b1c3;font-size:13px}.main-nav a.active{color:#f1d29b;background:#e5c48714}.sidebar-bottom{margin-top:auto;padding-top:16px;border-top:1px solid var(--border);font:18px Georgia,serif;color:#a0abba}.main-shell{margin-left:236px}.topbar{display:flex;gap:14px;justify-content:space-between;align-items:center;padding:18px 40px;border-bottom:1px solid var(--border);min-height:76px}.topbar nav{display:flex;gap:14px;flex-wrap:wrap}.topbar a{font-size:13px}.content{max-width:1600px;margin:auto;padding:34px 40px}.eyebrow{font-size:11px;letter-spacing:1.7px;color:var(--gold)}.eyebrow span{letter-spacing:normal;color:#8796a8}.heading{display:flex;justify-content:space-between;align-items:end;gap:22px;margin:20px 0}.heading h1{font:clamp(36px,5vw,60px)/1.1 Georgia,serif;max-width:720px}.heading h1 span{color:var(--gold)}.heading p{color:#a4b0c0;margin:14px 0 0}.button,button{cursor:pointer;border-radius:4px;border:1px solid #3a4656;padding:10px 15px;background:#203046;color:#edf0f2;font:inherit}.button.gold,button.gold{background:var(--gold);color:#15202d}.catalog-search{display:flex;gap:10px;margin:26px 0 12px}.catalog-search input{max-width:800px;flex:1}.search-field{position:relative;flex:1;min-width:0}.search-field input{width:100%;max-width:none}#thin-search-suggestions{position:absolute;inset:100% 0 auto 0;z-index:5;max-height:320px;overflow:auto;border:1px solid var(--border);background:#172436;box-shadow:0 12px 24px #0005}#thin-search-suggestions[hidden]{display:none}#thin-search-suggestions button{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--border);border-radius:0}.facet-toggle{font-size:12px;padding:7px 12px}.thin-save{display:block;margin-top:8px;width:100%;text-align:center;font-size:12px}.commercial-shortcuts{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 28px;font-size:13px}.commercial-shortcuts a{color:#e0c38e}.catalog-controls,.filter-row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.catalog-controls{border-top:1px solid var(--border);padding-top:18px;margin:18px 0}.topic-tabs{display:flex;gap:16px;flex-wrap:wrap}.topic-tabs a{font-size:13px}.filter-row{margin-bottom:14px;color:#a6b3c1}.filter-row select{max-width:220px}.filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}.filters a{border:1px solid #3a4656;border-radius:5px;padding:7px 12px;font-size:12px}.book-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:26px 22px}.book-card{min-width:0}.book-card .cover{display:flex;align-items:center;justify-content:center;height:280px;background:#2d4051;border:1px solid #35485a;padding:14px}.book-card img{object-fit:contain;max-height:240px;max-width:100%;height:auto;width:auto}.cover-fallback{font:19px Georgia,serif;text-align:center;color:#f1d29b}.genre{color:#e0c38e;font-size:11px;text-transform:uppercase;letter-spacing:.5px}.book-card h3{font:18px/1.25 Georgia,serif;margin:9px 0}.book-card p{margin:7px 0;color:#d0d9e3;font-size:13px}.book-card small{color:#9eaec0}.book-card>a:not(.cover){color:#e0c38e;font-size:12px}.pagination,.thin-placement{border-top:1px solid var(--border);padding:24px 0;margin-top:28px}.thin-placement h3{font:26px Georgia,serif}.thin-placement p{color:#a4b0c0}.thin-placement a{color:var(--gold)}.discovery{border-top:1px solid var(--border);margin-top:35px;padding-top:27px}.discovery h2{font:30px Georgia,serif}.discovery p{color:#a1adbe}.discovery form{display:grid;gap:12px;max-width:800px;margin-top:14px}.discovery label{display:grid;gap:4px}.discovery .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.discovery .actions{display:flex;gap:10px;flex-wrap:wrap}.thin-recommendations{display:flex;flex-wrap:wrap;gap:12px}.thin-recommendations a{padding:12px;border:1px solid var(--border)}input,select{background:#1a2739;color:#edf0f2;border:1px solid #3a4656;border-radius:4px;padding:10px;min-width:0;font:inherit}.locale{display:flex;align-items:center;gap:7px;font-size:12px}.locale select{padding:5px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}footer{border-top:1px solid var(--border);margin-top:38px;padding-top:20px;font-size:12px;color:#a1adbe;display:flex;gap:18px;flex-wrap:wrap}.mobile-menu{display:none}
@media(max-width:1180px){.book-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.topbar,.content{padding-left:25px;padding-right:25px}}
@media(max-width:800px){.sidebar{display:none}.main-shell{margin-left:0}.topbar,.content{padding:14px 16px}.topbar{min-height:48px}.book-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.book-card .cover{height:185px;padding:8px}.book-card h3{font-size:16px}.heading h1{font-size:36px}.heading{display:block}.heading p{font-size:13px}.mobile-menu{display:block}.mobile-menu nav{display:flex;flex-direction:column;gap:12px;padding:8px}.topbar nav{gap:8px}.discovery .two{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
 
/* Shared visual language with Cove's live fore.css, without React hydration. */
:root{--background:#0c1625;--foreground:#edf0f5;--border:#293344}
.topbar{height:88px;min-height:88px;border-color:#293344}
.thin-crumb{color:#d7dfe6;font-size:13px}
.thin-crumb strong{font-weight:400}
.content{padding-top:38px}
.eyebrow{color:#dec18b;letter-spacing:1.9px;font-size:11px}
.eyebrow span{display:inline-block;border-left:1px solid #384051;padding-left:14px;margin-left:10px;font-size:12px;letter-spacing:.2px;color:#8796a8}
.heading{align-items:center;margin:15px 0 24px}
.heading h1{font:400 clamp(32px,3.2vw,47px)/1.18 Georgia,serif;letter-spacing:-1.3px;margin:0}
.heading p{color:#95a2b4;font-size:14px;margin-top:11px}
.catalog-search{display:flex;align-items:center;gap:10px;border:1px solid #3a475b;border-radius:6px;background:#142033;padding:0 15px;min-height:56px;margin:0}
.catalog-search:focus-within{border-color:#c6ac7e}
.search-field:before{content:"⌕";position:absolute;top:50%;left:3px;transform:translateY(-55%);font-size:24px;color:#b1bfd0;line-height:1}
.search-field input{background:transparent;border:0;outline:0;padding:12px 0 12px 27px;font-size:15px}
.search-field input:focus-visible{outline:0}
.commercial-shortcuts{gap:9px;margin:16px 0 12px}
.commercial-shortcuts a{border:1px solid #334258;background:#111d2e;color:#cbd5e1;border-radius:999px;padding:8px 13px;font-size:12px}
.thin-category-browse{border:1px solid #344258;border-radius:6px;margin:0 0 16px}
.thin-category-browse summary{cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:12px 15px;color:#cbd5e1;font-size:13px}
.thin-category-browse summary:after{content:"⌄";color:#c4d0e1}
.thin-category-browse[open] summary:after{content:"⌃"}
.thin-category-browse nav{display:flex;flex-wrap:wrap;gap:12px;padding:10px 15px;font-size:13px}
.catalog-controls{border:0;padding:0;margin:16px 0 0}
.catalog-controls>span{display:none}
.topic-tabs{gap:22px;overflow-x:auto;flex-wrap:nowrap;white-space:nowrap;border-bottom:1px solid #2f3b4c}
.topic-tabs a{padding:0 0 16px;font-size:14px;color:#91a1b7}
.topic-tabs a[aria-current="page"]{color:#efd29d;border-bottom:2px solid #e5c17c}
.filter-row{margin:20px 0 12px;display:flex;align-items:center;gap:12px}
.catalog-count{font-size:13px;color:#8393a9}
.filter-selects{display:flex;gap:8px;min-width:0}
.filter-selects select,.thin-advanced-facets>select{border:1px solid #344258;background:#111d2e;color:#cbd5e1;border-radius:5px;font-size:12px;min-height:36px;padding:6px 11px}
.filter-selects select{width:auto;max-width:180px}
.thin-advanced-facets{display:flex;flex-wrap:wrap;gap:9px;margin:0 0 24px;align-items:center}
.thin-advanced-facets>select{min-width:146px;flex:1 1 165px}
.thin-advanced-facets .filters{display:contents}
.facet-toggle{height:36px;padding:0 13px;background:transparent;border:1px solid #344258;border-radius:5px;color:#9cabbe;font-size:12px}
.thin-facet-field{min-height:36px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border:1px solid #344258;border-radius:8px;color:#a2afbf;font-size:12px;white-space:nowrap}
.thin-facet-field input{background:transparent;border:0;width:90px;padding:6px 0;font-size:12px}
.thin-facet-field.date{flex:1 1 260px}
.thin-facet-field.date input{width:auto;margin-left:auto;max-width:160px}
.thin-apply-filters{border:1px solid #b99b66;background:#182536;color:#efd29d;font-size:12px;min-height:36px}
@media(max-width:800px){
  .topbar{height:68px;min-height:68px;padding:0 16px;gap:8px;justify-content:space-between}
  .mobile-menu{order:-4;display:block}
  .mobile-menu summary{list-style:none;cursor:pointer;font-size:0;width:28px;height:30px;display:flex;align-items:center}
  .mobile-menu summary::-webkit-details-marker{display:none}
  .mobile-menu summary:before{content:"☰";font-size:21px;color:#a4b2c4}
  .mobile-menu[open] nav{position:absolute;top:68px;left:0;right:0;background:#111c2c;z-index:20;padding:14px;box-shadow:0 14px 18px #0007}
  .thin-crumb{order:-3;font-size:12px;white-space:nowrap}
  .thin-crumb strong,.thin-crumb-separator{display:none}
  .locale{order:-2;display:flex;flex-direction:row-reverse}
  .locale select{padding:5px;font-size:11px;max-width:70px}
  .locale{font-size:0}
  .topbar nav[aria-label="Account"]{order:-1;display:flex;align-items:center;gap:10px;flex-wrap:nowrap}
  .topbar nav[aria-label="Account"] a:first-child{font-size:12px;max-width:34px;text-align:center;line-height:17px}
  .topbar nav[aria-label="Account"] a.button{min-height:53px;padding:9px 11px;font-size:12px;width:110px;text-align:center;line-height:18px}
  .content{padding:22px 16px}
  .eyebrow{margin:0 0 17px}
  .eyebrow span{display:none}
  .heading{margin:0 0 24px}
  .heading h1{font-size:38px;line-height:1.15;letter-spacing:-1px}
  .heading p{margin:12px 0 0;font-size:14px;line-height:1.5}
  .heading>a{display:none}
  .catalog-search{margin:0;min-height:56px;padding:0 12px}
  .catalog-search button[type="submit"]{position:absolute;width:1px;height:1px;padding:0;clip-path:inset(50%);overflow:hidden}
  .search-field input{width:100%;padding:16px 0 16px 29px;text-overflow:ellipsis}
  .commercial-shortcuts{margin:16px 0 14px;flex-wrap:nowrap;overflow:auto;white-space:nowrap}
  .commercial-shortcuts a{flex-shrink:0;padding:9px 12px}
  .thin-category-browse{margin-bottom:19px}
  .catalog-controls{margin:0}
  .topic-tabs{gap:22px}
  .topic-tabs a{font-size:13px;padding:9px 0 16px}
  .filter-row{align-items:flex-start;gap:10px;margin:20px 0 12px}
  .catalog-count{flex:0 0 52px;font-size:12px;line-height:18px}
  .filter-selects{flex:1;gap:8px;overflow:hidden}
  .filter-selects select{min-width:0;flex:1 1 0;padding:7px 5px}
  .filter-selects select:last-child{max-width:46px}
  .thin-advanced-facets{gap:9px;margin-bottom:24px}
  .thin-advanced-facets>select{flex:1 1 135px}
  .thin-advanced-facets .facet-toggle{flex:1 1 auto}
  .thin-facet-field{flex:1 1 120px}
  .thin-facet-field.date{flex:1 1 100%}
  .thin-apply-filters{flex:1 1 100%}
}

@media(max-width:800px){
  .thin-category-browse{margin-bottom:13px}
  .catalog-controls{margin-top:0}
  .filter-row{margin-top:16px}
  .catalog-count{flex:0 0 48px;font-size:12px;line-height:18px}
  .filter-selects{gap:8px;align-items:center}
  .filter-selects select:first-child{flex:0 0 98px;width:98px}
  .filter-selects select:nth-child(2){flex:0 0 94px;width:94px}
  .thin-sort-wrapper{display:flex;align-items:center;justify-content:center;position:relative;flex:1 1 auto;min-width:65px;height:36px;border:1px solid #344258;border-radius:5px;background:#111d2e;color:#cbd5e1}
  .thin-sort-wrapper>span{font-size:18px}
  .thin-sort-wrapper select{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer}
  .thin-advanced-facets>select[name="minRating"]{flex:0 0 215px;max-width:215px}
  .thin-facet-field:has(input[name="minPrice"]){flex:1 0 133px}
  .thin-facet-field.max{flex:0 0 134px}
}
</style></head><body><a class="skip" href="#main">Skip to books</a><div class="fore-app"><aside class="sidebar"><a class="logo" href="/">Cove<span>.</span></a><p class="nav-label">DISCOVER</p><nav class="main-nav" aria-label="Main">${nav}</nav><div class="sidebar-bottom">Find your next great read.</div></aside><div class="main-shell"><header class="topbar"><div class="thin-crumb"><strong>Cove</strong><span class="thin-crumb-separator"> / </span>Bookstore</div><nav aria-label="Account"><a href="/?storefront=full&amp;auth=login">Log in</a><a class="button gold" href="/?storefront=full&amp;auth=signup">Create account</a></nav><details class="mobile-menu"><summary aria-label="Open navigation">Menu</summary><nav aria-label="Mobile">${nav}</nav></details><label class="locale">Storefront language<select id="thin-locale" aria-label="Storefront language">${options}</select></label><span id="thin-locale-status" role="status" class="sr-only"></span></header><main id="main" class="content"><div class="eyebrow">${escape(eyebrow)} <span>Good books. Open to everyone.</span></div><div class="heading"><div><h1>${escape(headline)}<span>.</span></h1><p>${escape(description)}</p></div><a href="/library">Your library ↗</a></div><form class="catalog-search" action="/search" method="get" role="search"><label class="sr-only" for="thin-search">Search books by title, author, series, ISBN, publisher, or catalog ID</label><div class="search-field"><input id="thin-search" type="search" name="q" autocomplete="off" aria-label="Search books by title, author, series, ISBN, publisher, or catalog ID" aria-controls="thin-search-suggestions" aria-expanded="false" placeholder="Search titles, authors, series, ISBNs, publishers…"><div id="thin-search-suggestions" role="listbox" aria-label="Book suggestions" hidden></div></div><button type="submit">Search</button></form><nav class="commercial-shortcuts" aria-label="Bookstore destinations"><a href="/bestsellers">Bestsellers</a><a href="/new-releases">New releases</a><a href="/preorders">Coming soon</a><a href="/deals">Deals</a></nav><details class="thin-category-browse"><summary>Browse categories</summary><nav aria-label="Browse categories"><a href="/ebooks">Fiction &amp; Literature</a><a href="/ebooks?taxonomy=classics">Classics</a><a href="/ebooks?taxonomy=adventure">Adventure</a><a href="/store">All categories</a></nav></details><div class="catalog-controls"><nav class="topic-tabs" aria-label="Featured book categories"><a href="/store" aria-current="page">All books</a><a href="/ebooks?taxonomy=fiction">Fiction &amp; Literature</a><a href="/ebooks?taxonomy=classics">Classics</a><a href="/ebooks?taxonomy=adventure">Adventure</a></nav><span>Books available to read</span></div><div class="filter-row"><span class="catalog-count">${bootstrap.catalog.results.length} books</span><div class="filter-selects"><select data-thin-filter="language" aria-label="Languages"><option value="all">All languages</option><option value="en">English</option><option value="fr">French</option><option value="es">Spanish</option></select><select data-thin-filter="format" aria-label="Formats"><option value="all">All formats</option><option value="epub">EPUB</option><option value="pdf">PDF</option></select><span class="thin-sort-wrapper"><span aria-hidden="true">☷</span><select data-thin-filter="sort" aria-label="Sort books"><option value="popular">Popular</option><option value="bestselling">Bestselling on Cove</option><option value="released">Recently released</option><option value="price_asc">Price: low to high</option><option value="title">Title A–Z</option></select></span></div></div><form class="thin-advanced-facets" action="/store" method="get"><select name="taxonomy" aria-label="Categories"><option value="">All categories</option><option value="fiction">Fiction &amp; Literature</option><option value="classics">Classics</option><option value="adventure">Adventure</option></select><select name="publisher" aria-label="Publishers"><option value="">All publishers</option></select><select name="series" aria-label="Series"><option value="">All series</option></select><div class="filters" aria-label="Search filters"><button type="button" class="facet-toggle" data-thin-href="/deals">Deals</button><button type="button" class="facet-toggle" data-thin-href="/new-releases">New releases</button><button type="button" class="facet-toggle" data-thin-href="/preorders">Preorders</button><button type="button" class="facet-toggle" data-thin-href="/store?subscription=true">Subscription</button><button type="button" class="facet-toggle" data-thin-href="/store?library=true">Library eligible</button></div><select name="minRating" aria-label="Minimum rating"><option value="">Any rating</option><option value="4">4 stars &amp; up</option><option value="3">3 stars &amp; up</option></select><label class="thin-facet-field"><span>Min $</span><input type="number" step="0.01" min="0" name="minPrice" aria-label="Minimum price" placeholder="0"></label><label class="thin-facet-field max"><span>Max $</span><input type="number" step="0.01" min="0" name="maxPrice" aria-label="Maximum price" placeholder="Any"></label><label class="thin-facet-field date"><span>Published after</span><input type="date" name="publishedAfter" aria-label="Published after"></label><label class="thin-facet-field date"><span>Published before</span><input type="date" name="publishedBefore" aria-label="Published before"></label><button class="thin-apply-filters" type="submit">Apply filters</button></form><div class="book-grid" data-rights-country="${escape(context.rightsCountry)}">${cardsMarkup}</div><div class="pagination"><a href="${bootstrap.catalog.next ? "/store?page=2" : "/store"}" aria-label="Browse the complete catalog">Browse more books ↗</a></div><div id="thin-merchandising" aria-label="Featured storefront campaigns"></div><section class="discovery" aria-labelledby="literary-discovery-title"><h2 id="literary-discovery-title">What would you love to read next?</h2><p>Explore by theme, mood, style or setting. Results use available book evidence.</p><form id="thin-discovery-form"><label for="thin-discovery-query">For this search<input id="thin-discovery-query" maxlength="500" placeholder="mystery, reflective, less violence"></label><div class="two"><label for="thin-discovery-likes">More of (comma-separated)<input id="thin-discovery-likes" maxlength="1000" placeholder="friendship, witty"></label><label for="thin-discovery-dislikes">Avoid known themes or styles<input id="thin-discovery-dislikes" maxlength="1000" placeholder="war, melancholic"></label><label for="thin-discovery-minutes">Maximum reading time in minutes<input id="thin-discovery-minutes" type="number" min="5" max="10000" placeholder="Any length"></label><label for="thin-discovery-adventure">Discovery adventure<input id="thin-discovery-adventure" type="range" min="0" max="1" step="0.1" value="0.3"></label></div><p>Avoid filters exclude books tagged with those terms; incomplete profiles may have unrecorded content.</p><div class="actions"><button type="submit" class="gold">Discover books</button><button type="reset">Clear preferences</button><a class="button" href="/?storefront=full#literary-discovery-title">Full literary discovery</a></div></form><p id="thin-discovery-status" role="status" aria-live="polite"></p><div id="thin-discovery-results"></div></section><section class="thin-placement"><h3>Read anywhere</h3><p>Keep your library and reading tools close, online or offline.</p><button id="thin-install" type="button">Install Cove</button><a href="/downloads">Offline reading and downloads</a></section><footer><span>Cove · Read something that stays with you.</span><a href="/publishing-policy">Publishing &amp; AI policy</a><a href="/copyright">Copyright / DMCA</a><a href="/privacy">Privacy</a><span>Availability follows the rights determination for your storefront country.</span></footer></main></div></div><script type="module">${behavior}</script></body></html>`;
}
