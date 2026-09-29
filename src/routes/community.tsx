import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { CommunityPage } from "@/features/fore/Community";
export const Route=createFileRoute("/community")({component:()=> <SiteShell active="/community" title="Community"><CommunityPage/></SiteShell>});
