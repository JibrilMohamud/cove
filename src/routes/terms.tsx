import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { TermsPage } from "@/features/fore/Legal";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — Cove" },
      {
        name: "description",
        content:
          "Read the terms for using Cove, including account, reading, copyright, and community rules.",
      },
    ],
  }),
  component: () => (
    <SiteShell title="Terms of Service">
      <TermsPage />
    </SiteShell>
  ),
});
