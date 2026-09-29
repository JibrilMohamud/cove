import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";

export const Route = createFileRoute("/campaign/$slug")({
  head: ({ params }) => ({
    meta: [
      { title: `${String(params.slug || "Campaign").replace(/-/g, " ")} | Cove` },
      { name: "description", content: "A curated Cove bookstore collection." },
    ],
    links: [{ rel: "canonical", href: `/campaign/${params.slug}` }],
  }),
  component: CampaignPage,
});

function CampaignPage() {
  const { slug } = Route.useParams();
  return <SiteShell title="Cove collection"><StorePage landingPath={`/campaign/${slug}`} /></SiteShell>;
}
