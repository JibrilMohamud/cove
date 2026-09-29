import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { PublishingPage } from "@/features/fore/Publishing";
export const Route=createFileRoute("/publishing")({head:()=>({meta:[{title:"Cove Publishing"},{name:"robots",content:"noindex,nofollow"}]}),component:()=> <SiteShell active="/publishing" title="Cove Publishing"><PublishingPage/></SiteShell>});
