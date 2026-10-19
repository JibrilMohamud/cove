import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/** This modal has no SSR-visible content when closed.
 * Import it only after a visitor opens the mobile navigation, rather than
 * including the Radix drawer dependency in every anonymous cold render.
 */
export default function MobileNavDrawer({
  open,
  onOpenChange,
  side,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  side: "left" | "right";
  title: string;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={side} className="mobile-sidebar">
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
