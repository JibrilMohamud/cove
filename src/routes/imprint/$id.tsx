import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";
import { StorePage } from "@/features/fore/Store";
export const Route=createFileRoute("/imprint/$id")({head:()=>({meta:[{title:"Imprint books | Cove"},{name:"description",content:"Browse books from this imprint on Cove."}]}),component:Page});
function Page(){const {id}=Route.useParams();return <SiteShell title="Imprint"><StorePage landingPath={`/imprint/${encodeURIComponent(id)}`}/></SiteShell>}
