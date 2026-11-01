import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";

// Keep old Following bookmarks working without a separate personal-feed page.
function FollowingRedirect() {
  useEffect(() => {
    window.location.replace("/settings?tab=network");
  }, []);
  return (
    <SiteShell title="Network">
      <p className="muted">
        <a href="/settings?tab=network">Open Network settings</a>
      </p>
    </SiteShell>
  );
}

export const Route = createFileRoute("/following")({ component: FollowingRedirect });
