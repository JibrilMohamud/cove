import {createFileRoute} from "@tanstack/react-router";
import {SiteShell} from "@/features/fore/App";
import {WishlistPage} from "@/features/fore/Wishlist";
export const Route=createFileRoute("/wishlist")({head:()=>({meta:[{title:"Wishlist | Cove"},{name:"robots",content:"noindex,nofollow"}]}),component:()=> <SiteShell active="/wishlist" title="Wishlist"><WishlistPage/></SiteShell>});
