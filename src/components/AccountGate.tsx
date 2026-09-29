import { Link } from "@tanstack/react-router";
import { LockKeyhole, Search } from "lucide-react";

export function AccountGate({ title, description }: { title: string; description: string }) {
  return (
    <main className="mx-auto flex min-h-[70dvh] max-w-md items-center px-5 py-12">
      <section className="w-full rounded-[2rem] border border-border bg-card p-6 text-center shadow-glow">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary">
          <LockKeyhole className="h-6 w-6" />
        </div>
        <h1 className="mt-5 font-serif text-2xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
        <Link
          to="/profile"
          className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground"
        >
          Sign in or create a profile
        </Link>
        <Link
          to="/search"
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-full border border-border bg-background px-5 py-3 text-sm font-semibold"
        >
          <Search className="h-4 w-4" /> Search free books instead
        </Link>
      </section>
    </main>
  );
}
