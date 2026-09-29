import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
import { loadCategorySeo, seoHead } from "@/features/fore/seo-loader";

export const Route = createFileRoute("/ebooks/$")({
  loader:({params})=>loadCategorySeo({data:{path:String((params as any)._splat||"")}}),
  head:({loaderData})=>seoHead(loaderData),
  component: Page,
});
function Page() {
  const { _splat } = Route.useParams();
  const path = `/ebooks/${_splat || ""}`.replace(/\/$/, "");
  return <SiteShell title="Browse eBooks"><StorePage landingPath={path} /></SiteShell>;
}
