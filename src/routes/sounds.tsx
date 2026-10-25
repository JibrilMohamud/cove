/* eslint-disable prettier/prettier -- Initial music discovery UI follows the existing SoundtrackLibrary style until layout normalization. */
import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { CoveSoundsPage } from "@/features/fore/CoveSounds";

export const Route = createFileRoute("/sounds")({
  head: () => ({ meta: [
    { title: "Cove Sounds — Find your next story by feeling | Cove" },
    { name: "description", content: "Discover books through rights-reviewed music. Explore gothic, romantic, quiet and adventurous listening stations at Cove." },
    { property: "og:title", content: "Cove Sounds — Stories you can feel" },
    { property: "og:description", content: "Hear the atmosphere. Discover a world. Find your next book." },
  ] }),
  component: () => <SiteShell active="/sounds" title="Cove Sounds"><CoveSoundsPage /></SiteShell>,
});
