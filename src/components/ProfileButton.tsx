import { Link } from "@tanstack/react-router";
import { UserRound } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

export function ProfileButton() {
  const { user } = useAuth();
  const initial =
    (user?.user_metadata?.display_name as string | undefined)?.trim()?.[0] ??
    user?.email?.[0] ??
    null;

  return (
    <Link
      to="/profile"
      aria-label="Profile and reading settings"
      className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-sm font-semibold shadow-sm transition-transform active:scale-95"
    >
      {initial ? initial.toUpperCase() : <UserRound className="h-4.5 w-4.5" />}
    </Link>
  );
}
