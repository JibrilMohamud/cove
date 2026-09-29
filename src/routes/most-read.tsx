import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
export const Route = createFileRoute("/most-read")({ component: Page });
function Page(){ return <SiteShell title="Bookstore"><StorePage landingPath="/most-read" /></SiteShell>; }
