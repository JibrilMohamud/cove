import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { BookPage } from "@/features/fore/Book";
import { loadBookSeo, seoHead } from "@/features/fore/seo-loader";

export const Route=createFileRoute("/books/$id")({
  loader:({params})=>loadBookSeo({data:{id:params.id}}),
  head:({loaderData})=>seoHead(loaderData),
  component:Page,
});
function Page(){const {id}=Route.useParams();return <SiteShell title="Book details"><BookPage id={id}/></SiteShell>;}
