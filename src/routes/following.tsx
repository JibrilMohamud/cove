import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { AccountGuard } from "@/features/fore/Collections";

const Feed = lazy(() =>
  import("@/features/fore/Community").then((mod) => ({ default: mod.FollowingFeed })),
);

function FollowingRoute() {
  return (
    <SiteShell active="/following" title="Following">
      <AccountGuard>
        <div className="community-page">
          <a className="text-link" href="/community">
            ← Community
          </a>
          <Suspense fallback={<p role="status">Loading your reading circle…</p>}>
            <Feed />
          </Suspense>
        </div>
      </AccountGuard>
    </SiteShell>
  );
}

export const Route = createFileRoute("/following")({ component: FollowingRoute });
