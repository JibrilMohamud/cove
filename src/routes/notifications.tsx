import {createFileRoute} from "@tanstack/react-router";
import {SiteShell} from "@/features/fore/App";
import {NotificationsPage} from "@/features/fore/Notifications";
export const Route=createFileRoute("/notifications")({component:()=> <SiteShell active="/notifications" title="Notifications"><NotificationsPage/></SiteShell>});
