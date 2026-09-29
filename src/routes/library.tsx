import {createFileRoute} from "@tanstack/react-router";
import {SiteShell} from "@/features/fore/App";
import {LibraryPage} from "@/features/fore/Collections";
export const Route=createFileRoute("/library")({component:()=> <SiteShell active="/library" title="My library"><LibraryPage/></SiteShell>});
