/* eslint-disable prettier/prettier -- Initial music discovery UI follows the existing SoundtrackLibrary style until layout normalization. */
import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { CoveSoundsPage } from "@/features/fore/CoveSounds";
import { stationBySlug } from "@/features/fore/cove-sounds-stations";

export const Route = createFileRoute("/sounds/$slug")({
  head: ({ params }) => {
    const station = stationBySlug(params.slug);
    const title = station ? station.title + " — Cove Sounds" : "Cove Sounds";
    const description = station ? station.description + " Listen to approved music and find a book." : "Explore literary listening stations at Cove.";
    return { meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { name: "twitter:card", content: "summary_large_image" },
    ] };
  },
  component: StationRoute,
});

function StationRoute() {
  const { slug } = Route.useParams();
  return <SiteShell active="/sounds" title="Cove Sounds"><CoveSoundsPage slug={slug} /></SiteShell>;
}

