import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { CopyrightNoticePage } from "@/features/fore/RightsholderPolicy";
export const Route=createFileRoute("/copyright")({head:()=>({meta:[{title:"Copyright & DMCA — Cove"}]}),component:()=> <SiteShell active="" title="Copyright & DMCA"><CopyrightNoticePage/></SiteShell>});
