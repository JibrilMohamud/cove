import {AuthDialog,type AuthMode} from "./Auth";
import { Headphones, LibraryBig, BarChart3, Heart, ShoppingCart, ReceiptText, Building2, Bell, Users } from "lucide-react";
import { flushSessions } from "./reading-activity";
import { useState, useEffect, useCallback, type ReactNode } from "react";
import {
  BookOpen,
  Library,
  Highlighter,
  BookA,
  Download,
  Search,
  Menu,
  UserRound,
  ArrowUpRight,
  ChevronRight,
  X,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AccountContext, api, type AccountData } from "./client";
import "./fore.css";
import { registerReadingTools } from "./webmcp";
import { StorefrontLocaleControl, StorefrontLocaleProvider, useStorefrontLocale } from "./localization";
const nav = [
  ["/", "nav.bookstore", "Bookstore", BookOpen],
  ["/audiobooks", "nav.audiobooks", "Audiobooks", Headphones],
  ["/library", "nav.library", "My library", Library],
  ["/wishlist", "nav.wishlist", "Wishlist", Heart],
  ["/cart", "nav.cart", "Cart", ShoppingCart],
  ["/orders", "nav.orders", "Orders", ReceiptText],
  ["/notifications", "nav.notifications", "Notifications", Bell],
  ["/community", "nav.community", "Community", Users],
  ["/shelves", "nav.shelves", "Shelves", LibraryBig],
  ["/stats", "nav.stats", "Stats", BarChart3],
  ["/highlights", "nav.highlights", "Highlights & notes", Highlighter],
  ["/definitions", "nav.definitions", "Word collection", BookA],
  ["/downloads", "nav.downloads", "Downloads", Download],
  ["/publishing", "nav.publishing", "Cove Publishing", Building2],
] as const;
export function CoveProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AccountData>({
    user: null,
    library: [],
    annotations: [],
    bookmarks: [],
    definitions: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [auth, setAuth] = useState<AuthMode|null>(null);
  useEffect(()=>{const p=new URLSearchParams(location.search);const mode=p.get('auth');if(['login','signup','new-password'].includes(mode||'')){setAuth(mode as AuthMode);if(p.get('authError'))toast.error('The sign-in link could not be used. Try signing in with your verified email or request a new link.');history.replaceState(null,'',location.pathname);}},[]);
  const reload = useCallback(async () => {
    try {
      const next = await api<AccountData>("/account");
      setData(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    reload();
  }, [reload]);
  useEffect(() => registerReadingTools(reload), [reload]);
  useEffect(() => {
    if (!data.user) return;
    const flush = () => void flushSessions(data.user!.id).catch(() => {});
    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [data.user?.id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        const input = document.querySelector<HTMLInputElement>(".catalog-search input");
        if (input) {
          e.preventDefault();
          input.focus();
        }
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);
  return (
    <AccountContext.Provider value={{ data, loading, error, reload, signIn: () => setAuth("login"),signUp:()=>setAuth("signup") }}>
      <StorefrontLocaleProvider>{children}<AuthDialog mode={auth} onChange={setAuth} onSuccess={reload}/><Toaster theme="dark" position="bottom-right" richColors /></StorefrontLocaleProvider>
    </AccountContext.Provider>
  );
}
export function SiteShell({
  children,
  active = "/",
  title = "Bookstore",
}: {
  children: ReactNode;
  active?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const store=useStorefrontLocale();
  const links = (
    <>
      <a href="/" className="brand">
        <span className="brand-mark">
          <BookOpen size={25} strokeWidth={1.7} />
        </span>
        fore<span className="brand-period">.</span>
      </a>
      <div className="nav-label">{store.t("shell.yourReadingRoom","YOUR READING ROOM")}</div>
      <nav className="main-nav" aria-label="Primary">
        {nav.map(([href, key, fallback, Icon]) => (
          <a href={href} className={active === href ? "active" : ""} key={href}>
            <Icon size={19} strokeWidth={1.7} />
            {store.t(key,fallback)}
            {active === href && <ChevronRight size={15} className="nav-chevron" />}
          </a>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <p>
          {store.t("shell.tagline1","A good book is")}
          <br />
          {store.t("shell.tagline2","always a beginning.")}
        </p>
        <span>{store.t("shell.tagline3","YOUR BOOKSTORE. YOUR READING ROOM.")}</span>
      </div>
    </>
  );
  return (
    <div className="fore-app">
      <a className="skip-link" href="#fore-main">{store.t("shell.skip","Skip to main content")}</a>
      <aside className="sidebar" aria-label="Desktop navigation">{links}</aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side={store.direction==="rtl"?"right":"left"} className="mobile-sidebar">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {links}
        </SheetContent>
      </Sheet>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              onClick={() => setOpen(true)}
              aria-label={store.t("shell.openNav","Open navigation")}
            >
              <Menu size={22} />
            </button>
            <span>{store.t("shell.readingRoom","Reading room")}</span>
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions"><StorefrontLocaleControl/><AccountButton /></div>
        </header>
        <main id="fore-main" tabIndex={-1} className="content">{children}</main>
      </div>
    </div>
  );
}
import { useAccount } from "./client";
function AccountButton() {
  const { data, signIn,signUp } = useAccount();
  const store=useStorefrontLocale();
  return data.user ? (
    <a href="/profile" className="account-button">
      <span className="avatar">{(data.user.name || data.user.email || "R")[0].toUpperCase()}</span>
      <span>{data.user.name || store.t("account.mine","My account")}</span>
    </a>
  ) : (
    <div className="account-actions">
      <button className="text-link" onClick={signIn}>
        {store.t("account.login","Log in")}
      </button>
      <button className="button gold compact" onClick={signUp}>
        {store.t("account.create","Create account")} <ArrowUpRight size={15} />
      </button>
    </div>
  );
}
