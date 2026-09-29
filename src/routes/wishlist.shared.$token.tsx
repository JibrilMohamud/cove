import {createFileRoute} from "@tanstack/react-router";
import {SiteShell} from "@/features/fore/App";
import {SharedWishlistPage} from "@/features/fore/Wishlist";
export const Route=createFileRoute("/wishlist/shared/$token")({head:()=>({meta:[{title:"Shared wishlist | Cove"},{name:"robots",content:"noindex,nofollow"}]}),component:Page});
function Page(){const {token}=Route.useParams();return <SiteShell title="Shared wishlist"><SharedWishlistPage token={token}/></SiteShell>}
