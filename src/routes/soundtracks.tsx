import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { SoundtrackLibraryPage } from "@/features/fore/SoundtrackLibrary";
export const Route = createFileRoute("/soundtracks")({
  head: () => ({
    meta: [
      { title: "Soundtracks & music rights | Cove" },
      { name: "description", content: "Explore Cove's separately rights-reviewed recordings for reading, with music credits and source evidence." },
    ],
  }),
  component: () => (
    <SiteShell active="/soundtracks" title="Soundtrack library">
      <SoundtrackLibraryPage />
    </SiteShell>
  ),
});
