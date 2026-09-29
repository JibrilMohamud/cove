import {createFileRoute} from "@tanstack/react-router";
import {SiteShell} from "@/features/fore/App";
import {DownloadsPage} from "@/features/fore/Collections";
export const Route=createFileRoute("/downloads")({component:()=> <SiteShell active="/downloads" title="Downloads"><DownloadsPage/></SiteShell>});
