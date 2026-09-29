import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { AuthorProfilePage } from "@/features/fore/AuthorProfile";
import { loadAuthorSeo, seoHead } from "@/features/fore/seo-loader";

export const Route = createFileRoute("/author/$id")({
  loader:({params})=>loadAuthorSeo({data:{ref:params.id}}),
  head:({loaderData})=>seoHead(loaderData),
  component: Page,
});
function Page() { const { id } = Route.useParams(); return <SiteShell title="Author"><AuthorProfilePage authorRef={id} /></SiteShell>; }
