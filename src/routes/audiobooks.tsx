import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { AudiobooksPage } from "@/features/fore/Audio";
export const Route = createFileRoute("/audiobooks")({
  component: () => (
    <SiteShell active="/audiobooks" title="Audiobooks">
      <AudiobooksPage />
    </SiteShell>
  ),
});
