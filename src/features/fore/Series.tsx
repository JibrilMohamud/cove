import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, Check, Heart, Library, Loader2, ShoppingCart, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api, editionPath, readPath, useAccount, type CatalogBook } from "./client";
import { BookArt } from "./Store";

type Offer={currency:string;amountMinor:number};
type SeriesMember={book:CatalogBook;productId:string;editionId:string;workId:string;relationship:string;position:number|null;readingOrder:number|null;label:string;displayOrder:number;owned:boolean;readingStatus:string|null;progress:number;unread:boolean;wishlist:boolean;offer:Offer|null;subscriptionAvailable:boolean;libraryAvailable:boolean;releaseStatus:string};
type SeriesDetail={series:{id:string;name:string;slug:string;canonicalPath:string;description:string;seriesType:string;heroImageUrl:string;publisherId:string|null;publisherSlug:string|null;publisherName:string};members:SeriesMember[];nextUnread:SeriesMember|null;groups:{main:number;prequels:number;novellas:number;related:number};bulkPurchase:{eligible:boolean;productIds:string[];currency:string|null;totalMinor:number;reason:string|null}};
const money=(n:number,c:string)=>{try{return new Intl.NumberFormat(undefined,{style:"currency",currency:c}).format(n/100)}catch{return `${c} ${(n/100).toFixed(2)}`}};
const label=(m:SeriesMember)=>m.label||(m.relationship==="main"&&m.readingOrder?`Book ${m.readingOrder}`:m.relationship.replaceAll("_"," "));

function MemberRow({m,onWishlist}:{m:SeriesMember;onWishlist:(m:SeriesMember)=>void}){
  return <article className="series-member-row">
    <a className="series-member-cover" href={editionPath(m.book)}><BookArt book={m.book}/></a>
    <div className="series-member-copy"><div className="series-member-kicker">{label(m)}</div><a href={editionPath(m.book)}><h3>{m.book.title}</h3></a><p>{m.book.authors.map(a=>a.name).join(", ")||"Unknown author"}</p><div className="series-member-statuses">{m.owned&&<span><Check size={13}/> Owned</span>}{m.readingStatus==="finished"?<span>Read</span>:m.progress>0?<span>{Math.round(m.progress*100)}% read</span>:<span>Unread</span>}{m.subscriptionAvailable&&<span>Subscription</span>}{m.libraryAvailable&&<span><Library size={13}/> Library</span>}{m.releaseStatus==="preorder"&&<span>Preorder</span>}</div></div>
    <div className="series-member-actions">{m.offer?<strong>{money(m.offer.amountMinor,m.offer.currency)}</strong>:m.owned?<strong>In library</strong>:<span className="muted">Not for sale</span>}{m.owned?<a className="button outline" href={readPath(m.book.id)}><BookOpen size={15}/>Read</a>:<a className="button outline" href={editionPath(m.book)}>View edition</a>}<button className="icon-button" aria-label={m.wishlist?"Remove from wishlist":"Add to wishlist"} onClick={()=>onWishlist(m)}><Heart size={17} fill={m.wishlist?"currentColor":"none"}/></button></div>
  </article>;
}

export function SeriesPage({id}:{id:string}){
  const {data,signIn}=useAccount(); const [busy,setBusy]=useState("");
  const q=useQuery<SeriesDetail>({queryKey:["series-detail",id,data.user?.id||"anon"],queryFn:()=>api(`/series/${encodeURIComponent(id)}/detail`),retry:1});
  useEffect(()=>{const canonical=q.data?.series.canonicalPath;if(canonical&&typeof window!=="undefined"&&window.location.pathname!==canonical)window.history.replaceState(window.history.state,"",canonical+window.location.search);},[q.data?.series.canonicalPath]);
  if(q.isLoading)return <div className="empty-state"><Loader2 className="spin"/><p>Opening the series…</p></div>;
  if(!q.data)return <div className="empty-state"><h2>This series could not be opened.</h2><p>{q.error?.message}</p></div>;
  const d=q.data,groups=[{key:"main",title:d.series.seriesType==="unordered"?"Books in this collection":"Reading order",items:d.members.filter(x=>x.relationship==="main")},{key:"prequel",title:"Prequels",items:d.members.filter(x=>x.relationship==="prequel")},{key:"novella",title:"Novellas",items:d.members.filter(x=>x.relationship==="novella")},{key:"related",title:"Related works",items:d.members.filter(x=>!["main","prequel","novella"].includes(x.relationship))}].filter(g=>g.items.length);
  async function wishlist(m:SeriesMember){if(!data.user)return signIn();try{await api("/wishlist/item","POST",{productId:m.productId,saved:!m.wishlist,sourceSurface:"series-page"});await q.refetch();toast.success(m.wishlist?"Removed from wishlist":"Added to wishlist");}catch(e){toast.error((e as Error).message)}}
  async function addSeries(){if(!data.user)return signIn();if(!d.bulkPurchase.eligible)return;setBusy("series");try{await api(`/series/${encodeURIComponent(id)}/cart`,"POST",{});toast.success("Series added to cart");location.assign("/cart");}catch(e){toast.error((e as Error).message)}finally{setBusy("")}}
  return <div className="series-page"><a href="/store" className="text-link back-link"><ArrowLeft size={16}/>Back to bookstore</a>
    <header className="series-hero">{d.series.heroImageUrl&&<img src={d.series.heroImageUrl} alt=""/>}<div><span className="page-eyebrow">{d.series.seriesType==="unordered"?"BOOK COLLECTION":"BOOK SERIES"}</span><h1>{d.series.name}<span className="gold-text">.</span></h1><p>{d.series.description||`${d.groups.main} main title${d.groups.main===1?"":"s"}.`}</p>{d.series.publisherName&&(d.series.publisherId?<a className="text-link" href={`/publisher/${encodeURIComponent(d.series.publisherSlug||d.series.publisherId)}`}>{d.series.publisherName}</a>:<span>{d.series.publisherName}</span>)}<div className="series-summary-chips"><span>{d.groups.main} main</span>{d.groups.prequels>0&&<span>{d.groups.prequels} prequel{d.groups.prequels===1?"":"s"}</span>}{d.groups.novellas>0&&<span>{d.groups.novellas} novella{d.groups.novellas===1?"":"s"}</span>}</div></div></header>
    {d.nextUnread&&<section className="next-series-book"><Sparkles size={20}/><div><span className="small-label">NEXT UNREAD INSTALLMENT</span><h2>{d.nextUnread.book.title}</h2><p>{d.nextUnread.readingOrder?`Book ${d.nextUnread.readingOrder} · `:""}{d.nextUnread.offer?money(d.nextUnread.offer.amountMinor,d.nextUnread.offer.currency):d.nextUnread.owned?"Already in your library":d.nextUnread.subscriptionAvailable?"Available with subscription":"Available to you"}</p></div><a className="button gold" href={d.nextUnread.owned?readPath(d.nextUnread.book.id):editionPath(d.nextUnread.book)}>{d.nextUnread.owned?"Read next":"View next"}</a></section>}
    <div className="series-purchase-bar"><div><strong>{d.bulkPurchase.eligible?`${money(d.bulkPurchase.totalMinor,d.bulkPurchase.currency!)} for all main titles`:"Series purchase"}</strong><span>{d.bulkPurchase.eligible?"Eligible main eBooks can be added together.":d.bulkPurchase.reason}</span></div><button className="button gold" disabled={!d.bulkPurchase.eligible||!!busy} onClick={addSeries}>{busy?<Loader2 className="spin" size={16}/>:<ShoppingCart size={16}/>}Add series to cart</button></div>
    {groups.map(g=><section key={g.key} className="series-group"><div className="section-heading"><div><span className="small-label">{g.key==="main"&&d.series.seriesType==="ordered"?"CORRECT ORDER":g.key.toUpperCase()}</span><h2>{g.title}</h2></div></div><div className="series-member-list">{g.items.map(m=><MemberRow key={m.editionId} m={m} onWishlist={wishlist}/>)}</div></section>)}
  </div>;
}
