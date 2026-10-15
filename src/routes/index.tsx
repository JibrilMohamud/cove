import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
import { loadSiteSeo, seoHead } from "@/features/fore/seo-loader";
import { loadStorefrontBootstrap } from "@/features/fore/storefront-loader";
import type { StorefrontBootstrap } from "@/features/fore/storefront-bootstrap";
export const Route = createFileRoute("/")({
  staleTime: 60_000,
  loader: async ({ location }) => {
    const [seo, rawBootstrap] = await Promise.all([
      loadSiteSeo(),
      loadStorefrontBootstrap({ data: location.searchStr }),
    ]);
    const storefrontBootstrap: StorefrontBootstrap | null = rawBootstrap
      ? JSON.parse(rawBootstrap)
      : null;
    return { seo, storefrontBootstrap };
  },
  head: ({ loaderData }) => seoHead(loaderData?.seo),
  component: StorefrontRoute,
});

function StorefrontRoute() {
  const { storefrontBootstrap } = Route.useLoaderData();
  return (
    <SiteShell>
      <StorePage landingPath="/" initial={storefrontBootstrap} />
    </SiteShell>
  );
}
