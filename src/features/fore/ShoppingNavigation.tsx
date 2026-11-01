import { Heart, ReceiptText, ShoppingCart } from "lucide-react";
import { useUiText } from "./ui-text";
import "./shopping-nav.css";

// One navigation across three existing, independently loaded shopping routes.
// Never prefetch orders/wishlist while rendering cart or storefront.
const links = [
  { path: "/cart", label: "Cart", Icon: ShoppingCart },
  { path: "/wishlist", label: "Wishlist", Icon: Heart },
  { path: "/orders", label: "Orders", Icon: ReceiptText },
] as const;

export function ShoppingNavigation({ active }: { active: "/cart" | "/wishlist" | "/orders" }) {
  const ui = useUiText();
  return (
    <nav className="cove-shopping-nav" aria-label={ui("Shopping")}>
      {links.map(({ path, label, Icon }) => (
        <a
          key={path}
          href={path}
          aria-current={active === path ? "page" : undefined}
          className={active === path ? "selected" : ""}
        >
          <Icon size={17} aria-hidden="true" />
          {ui(label)}
        </a>
      ))}
    </nav>
  );
}
