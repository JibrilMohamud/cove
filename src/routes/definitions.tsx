import {createFileRoute} from "@tanstack/react-router";
import {SiteShell} from "@/features/fore/App";
import {DefinitionsPage} from "@/features/fore/Collections";
export const Route=createFileRoute("/definitions")({component:()=> <SiteShell active="/definitions" title="Word collection"><DefinitionsPage/></SiteShell>});
