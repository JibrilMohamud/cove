import { lazy, Suspense } from "react";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { SiteShell } from "@/features/fore/App";
import { AccountGuard } from "@/features/fore/Collections";

const ReaderPreferences = lazy(() =>
  import("@/features/fore/Community").then((mod) => ({ default: mod.MyCommunity })),
);
const AccountPreferences = lazy(() =>
  import("@/features/fore/Collections").then((mod) => ({ default: mod.ProfilePage })),
);
const NetworkPreferences = lazy(() =>
  import("@/features/fore/SettingsNetwork").then((mod) => ({
    default: mod.SettingsNetwork,
  })),
);

type SettingsTab = "preferences" | "account" | "network";
const tabs: { id: SettingsTab; label: string }[] = [
  { id: "preferences", label: "Preferences" },
  { id: "account", label: "Account" },
  { id: "network", label: "Network" },
];

function SettingsRoute() {
  const searchStr = useRouterState({ select: (s) => s.location.searchStr || "" });
  const rawTab = new URLSearchParams(searchStr).get("tab");
  const tab: SettingsTab = rawTab === "account" || rawTab === "network" ? rawTab : "preferences";
  return (
    <SiteShell active="/settings" title="Settings">
      <AccountGuard>
        <div className="community-page cove-preferences-page">
          <header className="cove-preferences-heading">
            <Settings2 size={24} aria-hidden="true" />
            <div>
              <h1>Settings</h1>
              <p>Manage your reading preferences, account, and network.</p>
            </div>
          </header>
          <nav className="cove-settings-tabs" aria-label="Settings sections">
            {tabs.map(({ id, label }) => (
              <a
                key={id}
                href={id === "preferences" ? "/settings" : `/settings?tab=${id}`}
                aria-current={tab === id ? "page" : undefined}
                className={tab === id ? "selected" : ""}
              >
                {label}
              </a>
            ))}
          </nav>
          <Suspense fallback={<p role="status">Loading settings…</p>}>
            {tab === "network" ? (
              <NetworkPreferences />
            ) : tab === "account" ? (
              <AccountPreferences />
            ) : (
              <ReaderPreferences />
            )}
          </Suspense>
        </div>
      </AccountGuard>
    </SiteShell>
  );
}

export const Route = createFileRoute("/settings")({ component: SettingsRoute });
