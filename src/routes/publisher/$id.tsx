import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";

export const Route = createFileRoute("/publisher/$id")({
  head: () => ({ meta: [{ title: "Publisher books | Cove" }, { name: "description", content: "Browse books from this publisher on Cove." }] }),
  component: Page,
});
function Page() { const { id } = Route.useParams(); return <SiteShell title="Publisher"><StorePage landingPath={`/publisher/${encodeURIComponent(id)}`} /></SiteShell>; }
