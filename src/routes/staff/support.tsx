import {createFileRoute} from "@tanstack/react-router";
import {SiteShell} from "@/features/fore/App";
import {SupportAdminPage} from "@/features/fore/Support";
export const Route=createFileRoute("/staff/support")({head:()=>({meta:[{title:"Cove Customer Support Operations"},{name:"robots",content:"noindex,nofollow"}]}),component:()=> <SiteShell title="Customer support"><SupportAdminPage/></SiteShell>});
