import { ArrowRight } from "lucide-react";
import { ModuleHead, ReaderCover, bookLink, dateLabel } from "./ReaderProfileBits";
import type { ProfileJourney, ProfileShelf, ProfileBook } from "./ReaderProfileBits";
export function ReaderProfileRail({ counts, journeys, shelves, current, url }: {
 counts:{ finished?:number; thisYear?:number };
 journeys: ProfileJourney[];
 shelves: ProfileShelf[];
 current?:{ book:ProfileBook|null; progress:number }|null;
 url:string;
}) {
 return <aside className="cove-reader-rail" aria-label="Reading highlights">
  <section><ModuleHead title="Reading at a glance"/>
   <div className="cove-reader-mini-stats">
    <div><strong>{Number(counts.finished||0)}</strong><span>Books read</span></div>
    <div><strong>{Number(counts.thisYear||0)}</strong><span>This year</span></div>
   </div>
  </section>
  {current?.book && <section><ModuleHead title="Currently reading"/>
    <a className="cove-reader-now" href={bookLink(current.book)}><ReaderCover book={current.book}/>
      <span><strong>{current.book.title}</strong><small>{current.book.authors}</small>
      <em>{Math.round(Math.min(1,Math.max(0,current.progress))*100)}% read</em></span></a>
  </section>}
  {shelves.length>0 && <section><ModuleHead title="Shelves" href={url+"&profileTab=Shelves"}/>
    {shelves.slice(0,4).map(item=><a className="cove-reader-aside-link"
      key={item.id} href={"/community?list="+encodeURIComponent(item.id)}>
      {item.title}<small>{item.item_count} books</small></a>)}
  </section>}
  </aside>;
}
