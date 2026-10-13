import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { HelpPage } from "@/features/fore/Help";
export const Route = createFileRoute("/help")({
  head: () => ({
    meta: [
      { title: "Help & support | Cove" },
      {
        name: "description",
        content:
          "Find help with Cove accounts, reading, downloads, orders, and private support requests.",
      },
    ],
  }),
  component: () => (
    <SiteShell active="/help" title="Help & support">
      <HelpPage />
    </SiteShell>
  ),
});
