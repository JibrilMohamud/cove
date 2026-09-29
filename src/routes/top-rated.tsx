import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
export const Route = createFileRoute("/top-rated")({ component: Page });
function Page(){ return <SiteShell title="Bookstore"><StorePage landingPath="/top-rated" /></SiteShell>; }
