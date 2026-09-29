import {createFileRoute} from "@tanstack/react-router";
import {SiteShell} from "@/features/fore/App";
import {HighlightsPage} from "@/features/fore/Collections";
export const Route=createFileRoute("/highlights")({component:()=> <SiteShell active="/highlights" title="Highlights & notes"><HighlightsPage/></SiteShell>});
