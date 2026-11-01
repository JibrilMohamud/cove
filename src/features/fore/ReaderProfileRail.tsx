import { ArrowRight } from "lucide-react";
import { ModuleHead } from "./ReaderProfileBits";
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
 </aside>;
}
