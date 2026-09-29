import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
export const Route = createFileRoute("/new-and-noteworthy")({ component: Page });
function Page(){ return <SiteShell title="Bookstore"><StorePage landingPath="/new-and-noteworthy" /></SiteShell>; }
