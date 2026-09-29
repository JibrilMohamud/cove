import { Link, useLocation } from "@tanstack/react-router";
import { House, Library, Store, Search, Highlighter } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

const publicTabs = [
  { to: "/", label: "Home", icon: House },
  { to: "/store", label: "Book Store", icon: Store },
  { to: "/search", label: "Search", icon: Search },
] as const;

const memberTabs = [
  { to: "/", label: "Reading Now", icon: House },
  { to: "/library", label: "Library", icon: Library },
  { to: "/store", label: "Book Store", icon: Store },
  { to: "/highlights", label: "Highlights", icon: Highlighter },
  { to: "/search", label: "Search", icon: Search },
] as const;

export function BottomTabs() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const tabs = user ? memberTabs : publicTabs;

  return (
    <nav
      aria-label="Primary"
      className="glass-panel fixed bottom-0 left-0 right-0 z-40 border-t border-border/70"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-around px-1 pb-1 pt-1.5">
        {tabs.map(({ to, label, icon: Icon }) => {
          const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
          return (
            <li key={to} className="min-w-0 flex-1">
              <Link
                to={to}
                className={cn(
                  "flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[9px] font-semibold tracking-wide transition-colors",
                  active ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-5 w-5" strokeWidth={active ? 2.35 : 1.75} />
                <span className="max-w-full truncate">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
