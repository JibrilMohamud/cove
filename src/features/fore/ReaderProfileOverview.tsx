import type { ReactNode } from "react";
import { ArrowRight, Pencil } from "lucide-react";
import { ReaderProfileSections } from "./ReaderProfileSections";
import { ReaderProfileRail } from "./ReaderProfileRail";
import "./reader-profile.css";
import "./reader-profile-cards.css";

type Result = {
 profile:{id:string;name?:string;username?:string;bio?:string};
 counts?:{followers?:number;following?:number;finished?:number;thisYear?:number};
 topBooks?:{position:number;book:import("./ReaderProfileBits").ProfileBook|null}[];
 lists?:import("./ReaderProfileBits").ProfileShelf[];
 journeys?:import("./ReaderProfileBits").ProfileJourney[];
 currentlyReading?:{book:import("./ReaderProfileBits").ProfileBook|null;progress:number}|null;
 relationship?:{following?:boolean;muted?:boolean;followRequestStatus?:string};
};
const tabs=["Profile","Activity","Library","Journal","Reviews","Want to Read","Shelves","Network","Stats","Conversation"];
export function ReaderProfileOverview({ result, owner, followLabel, follow, mute, block, report, discussion, tab }: {
 result:Result;owner:boolean;followLabel:string;follow:()=>void;mute:()=>void;block:()=>void;report:()=>void;
 discussion:ReactNode;tab:string|null;
}) {
 const profile=result.profile, counts=result.counts||{}, journeys=result.journeys||[], shelves=result.lists||[];
 const selected=tabs.includes(tab||"")?String(tab):"Profile";
 const url="/community?profile="+encodeURIComponent(profile.username||profile.id);
 const count=(n?:number)=>Number(n||0).toLocaleString();
 const summary:[string,number|undefined][]=[["Books read",counts.finished],["This year",counts.thisYear],["Shelves",shelves.length],["Following",counts.following],["Followers",counts.followers]];
 return <main className="cove-reader-profile">
  <header className="cove-reader-hero">
   <div className="cove-reader-avatar" aria-hidden="true">{(profile.name||"R").charAt(0).toUpperCase()}</div>
   <div className="cove-reader-identity"><span className="cove-reader-eyebrow">READER ON COVE</span>
    <div className="cove-reader-headline"><h1>{profile.name||"Reader"}</h1>
     {owner?<a href="/profile?section=me" className="cove-reader-follow"><Pencil size={14}/> Edit profile</a>:
      <div className="cove-reader-actions"><button onClick={follow} className="cove-reader-follow">{followLabel}</button>
       <details className="cove-reader-more"><summary aria-label="More reader actions">•••</summary>
        <div><button onClick={mute}>{result.relationship?.muted?"Unmute":"Mute"}</button><button onClick={block}>Block</button><button onClick={report}>Report</button></div>
       </details></div>}
    </div>
    {profile.username&&<p className="cove-reader-handle">@{profile.username}</p>}
    {profile.bio?.trim()&&<p className="cove-reader-bio">{profile.bio}</p>}
   </div>
   <div className="cove-reader-stats" aria-label="Reader statistics">{summary.map(([label,n])=>
    <div key={label}><strong>{count(n)}</strong><span>{label}</span></div>)}</div>
  </header>
  <nav className="cove-reader-nav" aria-label="Reader profile sections">
   {tabs.map(name=><a key={name} href={name==="Profile"?url:url+"&profileTab="+encodeURIComponent(name)}
    aria-current={selected===name?"page":undefined} className={selected===name?"active":""}>{name}</a>)}
  </nav>
  {selected==="Conversation"?<div className="cove-reader-discussion">{discussion}</div>:
   <div className="cove-reader-profile-layout">
    <div>
     <ReaderProfileSections top={result.topBooks||[]} journeys={journeys} shelves={shelves}
       tab={selected} owner={owner} url={url}/>
     {selected==="Network"&&<section className="cove-reader-empty"><h2>Reading together</h2>
      <p>{count(counts.followers)} followers · {count(counts.following)} following</p>
      <a href="/community?tab=discover">Discover readers <ArrowRight size={15}/></a></section>}
     {selected==="Want to Read"&&<section className="cove-reader-empty"><h2>Want to Read</h2>
      <p>Wishlists are private to their reader.</p>{owner&&<a href="/wishlist">Open wishlist <ArrowRight size={15}/></a>}</section>}
     {selected==="Stats"&&<section><h2>Reading stats</h2><div className="cove-reader-stat-cards">
       {([["Books finished",counts.finished],["This year",counts.thisYear],["Shared journeys",journeys.length],["Shared reviews",journeys.filter(x=>x.review_excerpt?.trim()).length]] as const).map(([name,n])=>
       <div key={name}><strong>{count(n)}</strong><span>{name}</span></div>)}
      </div></section>}
    </div>
    <ReaderProfileRail counts={counts} journeys={journeys} shelves={shelves}
      current={result.currentlyReading} url={url}/>
   </div>}
 </main>;
}
