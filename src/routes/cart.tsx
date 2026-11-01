import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { ShoppingNavigation } from "@/features/fore/ShoppingNavigation";
import { CartPage } from "@/features/fore/Commerce";
export const Route = createFileRoute("/cart")({
  head: () => ({
    meta: [{ title: "Cart | Cove" }, { name: "robots", content: "noindex,nofollow" }],
  }),
  component: () => (
    <SiteShell active="/cart" title="Cart">
      <ShoppingNavigation active="/cart" />
      <CartPage />
    </SiteShell>
  ),
});
