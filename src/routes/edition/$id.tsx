import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { EditionPage } from "@/features/fore/Edition";
import { loadEditionSeo, seoHead } from "@/features/fore/seo-loader";
export const Route=createFileRoute("/edition/$id")({
  loader:({params})=>loadEditionSeo({data:{id:params.id}}),
  head:({loaderData})=>seoHead(loaderData),
  component:Page,
});
function Page(){const {id}=Route.useParams();return <SiteShell title="Edition details"><EditionPage id={id}/></SiteShell>}
