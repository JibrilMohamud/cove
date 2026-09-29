import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
export const Route = createFileRoute("/new-releases")({
  head: () => ({ meta: [{ title: "New eBook Releases | Cove" }, { name: "description", content: "Browse recently released ebooks on Cove." }], links: [{ rel: "canonical", href: "/new-releases" }] }),
  component: () => <SiteShell title="New releases"><StorePage landingPath="/new-releases" /></SiteShell>,
});
