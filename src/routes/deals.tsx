import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
export const Route = createFileRoute("/deals")({
  head: () => ({ meta: [{ title: "eBook Deals | Cove" }, { name: "description", content: "Browse current ebook deals and limited-time offers on Cove." }], links: [{ rel: "canonical", href: "/deals" }] }),
  component: () => <SiteShell title="Deals"><StorePage landingPath="/deals" /></SiteShell>,
});
