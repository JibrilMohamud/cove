import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { BookPage } from "@/features/fore/Book";
import { loadBookSeo, seoHead } from "@/features/fore/seo-loader";
export const Route = createFileRoute("/book/$id")({
  loader: ({ params }) => loadBookSeo({ data: { id: params.id } }),
  head: ({ loaderData }) => seoHead(loaderData),
  component: Page,
});
function Page() {
  const { id } = Route.useParams();
  // The route has already fetched authorized public metadata for its SEO head.
  // Use only that title/cover to paint while private purchase/detail state loads.
  const initialSeo = Route.useLoaderData();
  return (
    <SiteShell title="Book details">
      <BookPage id={id} initialSeo={initialSeo} />
    </SiteShell>
  );
}
