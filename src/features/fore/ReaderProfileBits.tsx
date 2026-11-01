import { useState } from "react";
import { ArrowRight, BookOpen, Star } from "lucide-react";

export type ProfileBook = { productId?: string; title?: string; authors?: string; coverUrl?: string; sourceExternalId?: string };
export type ProfileJourney = {
 id: string; product_id?: string; title_snapshot: string; author_snapshot?: string;
 cover_url?: string; finished_at?: string; review_excerpt?: string | null; rating_steps?: number | null;
};
export type ProfileShelf = { id: string; title: string; description?: string; item_count: number };
export const bookLink = (b?: ProfileBook | null) =>
 b?.productId ? "/books/" + encodeURIComponent(b.productId) : "/bookstore";
export const dateLabel = (value?: string) =>
 value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

export function ReaderCover({ book }: { book?: ProfileBook | null }) {
 const [broken, setBroken] = useState(false);
 const source = book?.sourceExternalId;
 const local = new Set(["1342","2701","1661","2641","11","345","1260","84","2852","64317","768","2591","74","98","174","5200","2600","16","4300","120","1400","205","1080","46"]);
 const cover = book?.coverUrl || (source && local.has(source) ? "/covers/" + source + ".jpg" : "");
 return <span className="cove-reader-cover">
  {cover && !broken ? <img src={cover} alt={"Cover of "+(book.title||"book")}
    loading="lazy" decoding="async" onError={()=>setBroken(true)} /> :
   <span className="cove-reader-faux-cover" aria-label={book?.title||"Book"}>
    <BookOpen size={21}/><strong>{book?.title||"A story awaits"}</strong><small>{book?.authors||"COVE"}</small>
   </span>}
 </span>;
}
export function ModuleHead({ title, href }: { title: string; href?: string }) {
 return <div className="cove-reader-heading"><h2>{title}</h2>
  {href&&<a href={href}>All <ArrowRight size={14}/></a>}</div>;
}
export function JourneyEntry({ item }: { item: ProfileJourney }) {
 const book={productId:item.product_id,title:item.title_snapshot,authors:item.author_snapshot,coverUrl:item.cover_url};
 return <article className="cove-reader-journal">
  <a href={book.productId ? bookLink(book) : "/community?journey="+encodeURIComponent(item.id)}><ReaderCover book={book}/></a>
  <div><h3><a href={book.productId ? bookLink(book) : "/community?journey="+encodeURIComponent(item.id)}>{item.title_snapshot}</a></h3>
   <small>{item.author_snapshot}</small>
   <p>{dateLabel(item.finished_at)}</p>
   {Number(item.rating_steps)>0&&<span className="cove-reader-rating"><Star size={13} fill="currentColor"/> {(Number(item.rating_steps)/2).toFixed(1)}</span>}
   {!!item.review_excerpt?.trim()&&<p className="cove-reader-review">{item.review_excerpt}</p>}
   <a className="cove-reader-journey-link" href={"/community?journey="+encodeURIComponent(item.id)}>
    Reading journey <ArrowRight size={13}/></a>
  </div>
 </article>;
}
export function ShelfGrid({ items }: { items: ProfileShelf[] }) {
 return <div className="cove-reader-shelves">{items.map(s=><a key={s.id} href={"/community?list="+encodeURIComponent(s.id)}>
  <span className="cove-reader-spines" aria-hidden="true"><i/><i/><i/><i/><i/></span>
  <strong>{s.title}</strong>{s.description&&<p>{s.description}</p>}
  <small>{Number(s.item_count||0)} books</small>
 </a>)}</div>;
}
