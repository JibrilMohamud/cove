import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { ShelfPage } from "@/features/fore/Shelves";
export const Route = createFileRoute("/shelf/$id")({ component: Page });
function Page() {
  const { id } = Route.useParams();
  return (
    <SiteShell active="/shelves" title="Shelf">
      <ShelfPage id={id} />
    </SiteShell>
  );
}
