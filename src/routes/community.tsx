import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { CommunityPage } from "@/features/fore/Community";
import { CommunityProfileRoute } from "@/features/fore/CommunityProfileRoute";

function CommunityRoutePage() {
 const search = useRouterState({ select: (state) => state.location.searchStr || "" });
 const params = new URLSearchParams(search);
 const profile = params.get("profile");
 return (
  <SiteShell active="/community" title="Community">
   {profile ? <CommunityProfileRoute profileRef={profile} tab={params.get("profileTab")} /> : <CommunityPage />}
  </SiteShell>
 );
}
export const Route = createFileRoute("/community")({ component: CommunityRoutePage });
