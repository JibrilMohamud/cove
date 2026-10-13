import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { ServiceStatusPage } from "@/features/fore/ServiceStatus";
export const Route = createFileRoute("/status")({
  head: () => ({
    meta: [
      { title: "Service status | Cove" },
      {
        name: "description",
        content: "Current Cove service checks and published service updates.",
      },
    ],
  }),
  component: () => (
    <SiteShell active="/status" title="Service status">
      <ServiceStatusPage />
    </SiteShell>
  ),
});
