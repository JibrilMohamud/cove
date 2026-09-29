import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
import { loadSiteSeo, seoHead } from "@/features/fore/seo-loader";
export const Route = createFileRoute("/")({
  loader:()=>loadSiteSeo(),
  head:({loaderData})=>seoHead(loaderData),
  component: () => <SiteShell><StorePage landingPath="/" /></SiteShell>,
});
