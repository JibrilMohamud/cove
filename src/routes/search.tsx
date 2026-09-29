import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
export const Route = createFileRoute("/search")({
  head: () => ({ meta: [{ title: "Search eBooks | Cove" }, { name: "robots", content: "noindex,follow" }], links: [{ rel: "canonical", href: "/search" }] }),
  component: () => <SiteShell title="Search"><StorePage landingPath="/search" /></SiteShell>,
});
