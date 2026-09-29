import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { PublishingAdminPage } from "@/features/fore/Publishing";
export const Route=createFileRoute("/staff/publishing")({head:()=>({meta:[{title:"Cove Publishing Operations"},{name:"robots",content:"noindex,nofollow"}]}),component:()=> <SiteShell title="Publishing operations"><PublishingAdminPage/></SiteShell>});
