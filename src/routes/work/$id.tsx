import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { WorkPage } from "@/features/fore/Work";
import { loadWorkSeo, seoHead } from "@/features/fore/seo-loader";
export const Route=createFileRoute("/work/$id")({
  loader:({params})=>loadWorkSeo({data:{id:params.id}}),
  head:({loaderData})=>seoHead(loaderData),
  component:Page,
});
function Page(){const {id}=Route.useParams();return <SiteShell title="Work"><WorkPage id={id}/></SiteShell>}
