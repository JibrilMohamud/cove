import {createFileRoute} from "@tanstack/react-router";
import {SiteShell} from "@/features/fore/App";
import {ProfilePage} from "@/features/fore/Collections";
export const Route=createFileRoute("/profile")({component:()=> <SiteShell active="/profile" title="My account"><ProfilePage/></SiteShell>});
