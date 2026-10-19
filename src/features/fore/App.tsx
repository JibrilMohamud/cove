import type { AuthMode } from "./Auth";
import type { StorefrontBootstrap } from "./storefront-bootstrap";
import { ConnectionNotice } from "./ConnectionNotice";
import { CoveRequestError } from "./api-transport";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Headphones,
  LibraryBig,
  BarChart3,
  Heart,
  ShoppingCart,
  ReceiptText,
  Building2,
  Bell,
  Users,
  LifeBuoy,
} from "lucide-react";
import { flushSessions } from "./reading-activity";
import { flushReaderMutations } from "./offline-reader-mutations";
import { setOfflineAccount } from "./offline-account";
import { lazy, Suspense, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
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
import { AccountContext, api, type AccountData } from "./client";
import "./fore.css";
import "./legal.css";
import { registerReadingTools } from "./webmcp";
import {
  StorefrontLocaleControl,
  StorefrontLocaleProvider,
  useStorefrontLocale,
} from "./localization";
import { useUiText } from "./ui-text";
// The auth modal is never visible during anonymous homepage SSR. Loading
// its form, provider SDK, and dialog dependencies here unnecessarily widens
// every cold render's module graph. Only fetch it upon deliberate sign-in or
// an authentication callback; never defer the existing auth-state decision.
const AuthDialog = lazy(() => import("./Auth").then((module) => ({ default: module.AuthDialog })));
const MobileNavDrawer = lazy(() => import("./MobileNavDrawer"));
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
  ["/help", "nav.help", "Help & support", LifeBuoy],
] as const;
export function CoveProvider({
  children,
  initialStorefront,
}: {
  children: ReactNode;
  initialStorefront?: StorefrontBootstrap["context"];
}) {
  const queryClient = useQueryClient();
  const lastAccount = useRef<string | null | undefined>(undefined);
  const [data, setData] = useState<AccountData>({
    user: null,
    library: [],
    annotations: [],
    bookmarks: [],
    definitions: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null);
  const reloadVersion = useRef(0);
  const [auth, setAuth] = useState<AuthMode | null>(null);
  // Makes the client-hydrated state observable to device QA and diagnostics.
  // Static SSR links remain usable before this point.
  useEffect(() => {
    document.documentElement.dataset.coveClientReady = "true";
    return () => {
      delete document.documentElement.dataset.coveClientReady;
    };
  }, []);
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const mode = p.get("auth");
    if (["login", "signup", "new-password"].includes(mode || "")) {
      setAuth(mode as AuthMode);
      if (p.get("authError"))
        toast.error(
          "The sign-in link could not be used. Try signing in with your verified email or request a new link.",
        );
      history.replaceState(null, "", location.pathname);
    }
  }, []);
  const reload = useCallback(async () => {
    const version = ++reloadVersion.current;
    try {
      const next = await api<AccountData>("/account");
      if (version !== reloadVersion.current) return;
      const nextAccount = next.user?.id || null;
      await setOfflineAccount(nextAccount).catch(() => {});
      if (version !== reloadVersion.current) return;
      if (lastAccount.current !== undefined && lastAccount.current !== nextAccount) {
        await queryClient.cancelQueries();
        if (version !== reloadVersion.current) return;
        queryClient.clear();
      }
      lastAccount.current = nextAccount;
      setData(next);
      setError("");
      setErrorRequestId(null);
    } catch (e) {
      if (version !== reloadVersion.current) return;
      setError((e as Error).message);
      setErrorRequestId(e instanceof CoveRequestError ? e.requestId : null);
      if (e instanceof CoveRequestError && [401, 403].includes(e.status)) {
        await setOfflineAccount(null).catch(() => {});
        queryClient.clear();
        lastAccount.current = null;
        setData({ user: null, library: [], annotations: [], bookmarks: [], definitions: [] });
      }
    } finally {
      if (version === reloadVersion.current) setLoading(false);
    }
  }, [queryClient]);
  useEffect(() => {
    // Offline saves and push opt-in prepare the worker explicitly. A first
    // bookstore visit must not download the complete offline reader bundle.
    reload();
  }, [reload]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === "cove:offline-account:v1") void reload();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [reload]);
  useEffect(() => registerReadingTools(reload), [reload]);
  useEffect(() => {
    if (!data.user) return;
    const flush = () => {
      void flushSessions(data.user!.id).catch(() => {});
      void flushReaderMutations(data.user!.id).catch(() => {});
    };
    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [data.user]);
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
    <AccountContext.Provider
      value={{
        data,
        loading,
        error,
        errorRequestId,
        reload,
        signIn: () => setAuth("login"),
        signUp: () => setAuth("signup"),
      }}
    >
      <StorefrontLocaleProvider key={data.user?.id || "guest"} initialContext={initialStorefront}>
        {children}
        {auth !== null ? (
          <Suspense fallback={null}>
            <AuthDialog mode={auth} onChange={setAuth} onSuccess={reload} />
          </Suspense>
        ) : null}
        <Toaster theme="dark" position="bottom-right" richColors />
      </StorefrontLocaleProvider>
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
  const [drawerMounted, setDrawerMounted] = useState(false);
  const store = useStorefrontLocale();
  const ui = useUiText();
  const links = (
    <>
      <Link to="/" className="brand" onClick={() => setOpen(false)}>
        <span className="brand-mark">
          <BookOpen size={25} strokeWidth={1.7} />
        </span>
        cove<span className="brand-period">.</span>
      </Link>
      <div className="nav-label">{store.t("shell.yourReadingRoom", "YOUR READING ROOM")}</div>
      <nav className="main-nav" aria-label={ui("Primary")}>
        {nav.map(([href, key, fallback, Icon]) => (
          <Link
            to={href}
            className={active === href ? "active" : ""}
            key={href}
            onClick={() => setOpen(false)}
            preload={false}
          >
            <Icon size={19} strokeWidth={1.7} />
            {store.t(key, fallback)}
            {active === href && <ChevronRight size={15} className="nav-chevron" />}
          </Link>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <p>
          {store.t("shell.tagline1", "A good book is")}
          <br />
          {store.t("shell.tagline2", "always a beginning.")}
        </p>
        <span>{store.t("shell.tagline3", "YOUR BOOKSTORE. YOUR READING ROOM.")}</span>
        <nav className="sidebar-legal-links" aria-label={ui("Legal information")}>
          <a href="/terms">{ui("Terms")}</a>
          <a href="/privacy">{ui("Privacy")}</a>
          <a href="/copyright">{ui("Copyright")}</a>
        </nav>
      </div>
    </>
  );
  return (
    <div className="fore-app">
      <a className="skip-link" href="#fore-main">
        {store.t("shell.skip", "Skip to main content")}
      </a>
      <aside className="sidebar" aria-label={ui("Desktop navigation")}>
        {links}
      </aside>
      {drawerMounted ? (
        <Suspense fallback={null}>
          <MobileNavDrawer
            open={open}
            onOpenChange={setOpen}
            side={store.direction === "rtl" ? "right" : "left"}
            title={ui("Navigation")}
          >
            {links}
          </MobileNavDrawer>
        </Suspense>
      ) : null}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              onClick={() => { setDrawerMounted(true); setOpen(true); }}
              aria-label={store.t("shell.openNav", "Open navigation")}
            >
              <Menu size={22} />
            </button>
            <span>{store.t("shell.readingRoom", "Reading room")}</span>
            <ChevronRight size={13} />
            <strong>{ui(title)}</strong>
          </div>
          <div className="topbar-actions">
            <StorefrontLocaleControl />
            <AccountButton />
          </div>
        </header>
        <main id="fore-main" tabIndex={-1} className="content">
          <ConnectionNotice />
          {children}
        </main>
        <footer className="cove-site-footer" aria-label={ui("Cove legal and account links")}>
          <span>© {new Date().getFullYear()} Cove</span>
          <nav aria-label={ui("Footer")}>
            <a href="/terms">{ui("Terms of Service")}</a>
            <a href="/privacy">{ui("Privacy Policy")}</a>
            <a href="/copyright">{ui("Copyright & DMCA")}</a>
            <a href="/help">{ui("Help & support")}</a>
            <a href="/soundtracks">{ui("Soundtracks")}</a>
            <a href="/status">{ui("Service status")}</a>
            <a href="/privacy#contact-us">{ui("Contact & privacy requests")}</a>
          </nav>
        </footer>
      </div>
    </div>
  );
}
import { useAccount } from "./client";
function AccountButton() {
  const { data, signIn, signUp } = useAccount();
  const store = useStorefrontLocale();
  return data.user ? (
    <a href="/profile" className="account-button">
      <span className="avatar">{(data.user.name || data.user.email || "R")[0].toUpperCase()}</span>
      <span>{data.user.name || store.t("account.mine", "My account")}</span>
    </a>
  ) : (
    <div className="account-actions">
      <button className="text-link" onClick={signIn}>
        {store.t("account.login", "Log in")}
      </button>
      <button className="button gold compact" onClick={signUp}>
        {store.t("account.create", "Create account")} <ArrowUpRight size={15} />
      </button>
    </div>
  );
}
