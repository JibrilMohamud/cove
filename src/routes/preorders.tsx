import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
export const Route = createFileRoute("/preorders")({
  head: () => ({ meta: [{ title: "Upcoming eBooks & Preorders | Cove" }, { name: "description", content: "Browse upcoming ebooks and preorder listings on Cove." }], links: [{ rel: "canonical", href: "/preorders" }] }),
  component: () => <SiteShell title="Coming soon"><StorePage landingPath="/preorders" /></SiteShell>,
});
