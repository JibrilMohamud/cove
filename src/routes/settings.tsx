import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Settings2, UserRound, Bell } from "lucide-react";
import { SiteShell } from "@/features/fore/App";
import { AccountGuard } from "@/features/fore/Collections";

const ReaderPreferences = lazy(() =>
  import("@/features/fore/Community").then((mod) => ({ default: mod.MyCommunity })),
);

function SettingsRoute() {
  return (
    <SiteShell active="/settings" title="Settings">
      <AccountGuard>
        <div className="community-page cove-preferences-page">
          <header className="cove-preferences-heading">
            <Settings2 size={25} aria-hidden="true" />
            <div>
              <h1>Settings</h1>
              <p>Manage your reader identity, privacy, and who can interact with you.</p>
            </div>
          </header>
          <nav className="cove-preferences-shortcuts" aria-label="Account settings sections">
            <a href="/profile"><UserRound size={17} /> Account &amp; reading preferences</a>
            <a href="/notifications"><Bell size={17} /> Notification preferences</a>
          </nav>
          <Suspense fallback={<p role="status">Loading Community settings…</p>}>
            <ReaderPreferences />
          </Suspense>
        </div>
      </AccountGuard>
    </SiteShell>
  );
}

export const Route = createFileRoute("/settings")({ component: SettingsRoute });
