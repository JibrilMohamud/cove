import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { SeriesPage } from "@/features/fore/Series";
export const Route=createFileRoute("/series/$id")({head:()=>({meta:[{title:"Book series | Cove"},{name:"description",content:"Browse the reading order and related books in this series on Cove."}]}),component:Page});
function Page(){const {id}=Route.useParams();return <SiteShell title="Book series"><SeriesPage id={id}/></SiteShell>}
