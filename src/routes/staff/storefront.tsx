import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorefrontAdminPage } from "@/features/fore/StorefrontAdmin";
export const Route = createFileRoute("/staff/storefront")({
  head: () => ({ meta: [{ title: "Storefront CMS | Cove" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: () => <SiteShell title="Storefront CMS"><StorefrontAdminPage /></SiteShell>,
});
