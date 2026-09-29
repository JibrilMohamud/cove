import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { AudioPlayerPage } from "@/features/fore/Audio";
export const Route = createFileRoute("/listen/$id")({ component: Page });
function Page() {
  const { id } = Route.useParams();
  return (
    <SiteShell active="/audiobooks" title="Audiobook">
      <AudioPlayerPage id={id} />
    </SiteShell>
  );
}
