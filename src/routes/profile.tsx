import { lazy, Suspense } from "react";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { AccountGuard, ProfilePage } from "@/features/fore/Collections";

// Keep private social management out of the public Community bundle and
// load it only when its My Account section is opened.
const CommunityPreferences = lazy(() =>
  import("@/features/fore/Community").then((m) => ({ default: m.MyCommunity })),
);
const PrivateShares = lazy(() =>
  import("@/features/fore/Sharing").then((m) => ({ default: m.SharingPage })),
);

function ProfileRoutePage() {
  const searchString = useRouterState({ select: (state) => state.location.searchStr || "" });
  const section = new URLSearchParams(searchString).get("section");
  const isPrivateSection = section === "me" || section === "received" || section === "sharing";
  return (
    <SiteShell active="/profile" title="My account">
      {isPrivateSection ? (
        <AccountGuard>
          <main className="community-page">
            <a className="text-link" href="/profile">
              ← Back to My Account
            </a>
            <nav className="community-tabs" aria-label="Account and sharing">
              {[
                ["me", "Reader profile & clubs"],
                ["received", "Shared with me"],
                ["sharing", "My sharing"],
              ].map(([key, label]) => (
                <a
                  href={`/profile?section=${key}`}
                  className={section === key ? "active" : ""}
                  aria-current={section === key ? "page" : undefined}
                  key={key}
                >
                  {label}
                </a>
              ))}
            </nav>
            <Suspense fallback={<p role="status">Opening your account tools…</p>}>
              {section === "me" ? (
                <CommunityPreferences />
              ) : (
                <PrivateShares sent={section === "sharing"} />
              )}
            </Suspense>
          </main>
        </AccountGuard>
      ) : (
        <ProfilePage />
      )}
    </SiteShell>
  );
}

export const Route = createFileRoute("/profile")({
  component: ProfileRoutePage,
});
