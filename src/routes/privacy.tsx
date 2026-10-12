import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { PrivacyPage } from "@/features/fore/Legal";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — Cove" },
      {
        name: "description",
        content:
          "How Cove protects reading histories, libraries, notes, account information, and privacy rights.",
      },
    ],
  }),
  component: () => (
    <SiteShell title="Privacy Policy">
      <PrivacyPage />
    </SiteShell>
  ),
});
