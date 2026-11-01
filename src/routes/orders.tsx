import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { ShoppingNavigation } from "@/features/fore/ShoppingNavigation";
import { OrdersPage } from "@/features/fore/Commerce";
export const Route = createFileRoute("/orders")({
  head: () => ({
    meta: [{ title: "Orders | Cove" }, { name: "robots", content: "noindex,nofollow" }],
  }),
  component: () => (
    <SiteShell active="/orders" title="Orders">
      <ShoppingNavigation active="/orders" />
      <OrdersPage />
    </SiteShell>
  ),
});
