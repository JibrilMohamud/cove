import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { PublishingPolicyPage } from "@/features/fore/RightsholderPolicy";
export const Route=createFileRoute("/publishing-policy")({head:()=>({meta:[{title:"Publishing Content & AI Policy — Cove"}]}),component:()=> <SiteShell active="" title="Publishing Policy"><PublishingPolicyPage/></SiteShell>});
