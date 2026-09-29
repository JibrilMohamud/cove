import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StatsPage } from "@/features/fore/Stats";
export const Route = createFileRoute("/stats")({
  component: () => (
    <SiteShell active="/stats" title="Stats">
      <StatsPage />
    </SiteShell>
  ),
});
