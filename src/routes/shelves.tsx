import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { ShelvesPage } from "@/features/fore/Shelves";
export const Route = createFileRoute("/shelves")({
  component: () => (
    <SiteShell active="/shelves" title="Shelves">
      <ShelvesPage />
    </SiteShell>
  ),
});
