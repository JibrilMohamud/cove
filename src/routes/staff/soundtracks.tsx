import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { SoundtrackReviewPage } from "@/features/fore/SoundtrackReview";
export const Route = createFileRoute("/staff/soundtracks")({
  head: () => ({
    meta: [
      { title: "Soundtrack rights review | Cove" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: () => (
    <SiteShell title="Soundtrack rights review">
      <SoundtrackReviewPage />
    </SiteShell>
  ),
});
