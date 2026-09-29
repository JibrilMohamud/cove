import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen, CheckCircle2, Languages, Loader2 } from "lucide-react";
import { api } from "./client";
import { DiscussionThread } from "./Community";

type WorkDetail={
  work:{id:string;title:string;subtitle:string;description:string;originalLanguage:string;workType:string;canonicalStatus:string;contributors?:Array<{id:string;name:string;slug:string;role:string;position:number}>};
  editions:Array<{editionId:string;productId:string;externalBookId:string;title:string;subtitle:string;editionNumber:string;language:string;format:string;sourceName:string;publicationDate:string|null;releaseDate:string|null;isbn13:string|null;editionType:string;differentiationStatus:string;differentiationSummary:string;canonicalPublicDomain:boolean;publisher:string;imprint:string;contributors:Array<{name:string;role:string}>;offer:null|{amountMinor:number;currency:string};availableInTerritory:boolean;rightsReason:string;owned:boolean}>;
  audioEditions?:Array<{id:string;title:string;language:string;narration:string;narrator:string;rights:string}>;
  canonicalEditionId:string|null; redirectedFrom:string|null;
};
const editionLabels:Record<string,string>={canonical_public_domain:"Canonical free edition",annotated:"Annotated edition",new_translation:"New translation",illustrated:"Illustrated edition",scholarly:"Scholarly edition",commercial_audiobook:"Commercial audiobook",original:"Original edition"};
function money(value:number,currency:string){try{return new Intl.NumberFormat(undefined,{style:"currency",currency}).format(value/100);}catch{return `${currency} ${(value/100).toFixed(2)}`;}}
export function WorkPage({id}:{id:string}){
  const q=useQuery<WorkDetail>({queryKey:["work-detail",id],queryFn:()=>api(`/works/${encodeURIComponent(id)}`),retry:1});
  useEffect(()=>{if(!q.data||typeof document==="undefined")return;document.title=`${q.data.work.title} — all editions | Cove`;},[q.data]);
  if(q.isLoading)return <div className="empty-state"><Loader2 className="spin"/><p>Collecting editions…</p></div>;
  if(!q.data)return <div className="empty-state"><h2>This work could not be opened.</h2><p>{q.error?.message}</p></div>;
  const {work,editions}=q.data; const audioEditions=q.data.audioEditions||[];
  return <main className="work-page">
    <header className="work-hero">
      <span className="small-label">WORK</span><h1>{work.title}</h1>{work.subtitle&&<p className="work-subtitle">{work.subtitle}</p>}
      {work.contributors?.some(c=>c.role==="author")&&<p className="work-authors">by {work.contributors.filter(c=>c.role==="author").map(c=>c.name).join(", ")}</p>}{work.description&&<p className="work-description">{work.description}</p>}
      <div className="work-meta"><BookOpen size={16}/><span>{editions.length} edition{editions.length===1?"":"s"}</span>{work.originalLanguage&&<><Languages size={16}/><span>Originally {work.originalLanguage.toUpperCase()}</span></>}</div>
    </header>
    <section aria-labelledby="editions-heading"><div className="section-heading"><div><span className="small-label">CHOOSE A VERSION</span><h2 id="editions-heading">Editions</h2></div></div>
      <div className="work-edition-grid">{editions.map(e=>{const authors=e.contributors.filter(c=>c.role==="author").map(c=>c.name).join(", ");return <article className={`work-edition-card${e.canonicalPublicDomain?" canonical":""}`} key={e.editionId}>
        <div className="work-edition-top"><span className="edition-type-pill">{editionLabels[e.editionType]||e.editionType}</span>{e.canonicalPublicDomain&&<span className="canonical-pill"><CheckCircle2 size={14}/> Canonical</span>}</div>
        <h3>{e.title}</h3><p className="muted">{[authors,e.imprint||e.publisher,e.language.toUpperCase(),e.format==="ebook"?"eBook":e.format].filter(Boolean).join(" · ")}</p>
        {e.differentiationSummary&&<p className="edition-distinction">{e.differentiationSummary}</p>}
        <div className="work-edition-footer"><strong>{e.offer?money(Number(e.offer.amountMinor),String(e.offer.currency)):e.canonicalPublicDomain?"Free":e.availableInTerritory?"View availability":"Unavailable in your territory"}</strong>{e.owned&&<span className="owned-badge">Owned</span>}
          <Link to="/edition/$id" params={{id:e.editionId}} className="primary-btn">View edition</Link></div>
      </article>})}</div>
    </section>
    {audioEditions.length>0&&<section aria-labelledby="audio-editions-heading"><div className="section-heading"><div><span className="small-label">LISTEN</span><h2 id="audio-editions-heading">Audio editions</h2></div></div>
      <div className="work-edition-grid">{audioEditions.map(a=><article className="work-edition-card" key={a.id}>
        <div className="work-edition-top"><span className="edition-type-pill">{a.narration==="human"?"Human recording":"Computer narration"}</span></div>
        <h3>{a.title}</h3><p className="muted">{[a.narrator?`Narrated by ${a.narrator}`:"",a.language.toUpperCase(),"Public-domain audio"].filter(Boolean).join(" · ")}</p>
        <div className="work-edition-footer"><strong>Free</strong><a href={`/listen/${encodeURIComponent(a.id)}`} className="primary-btn">Listen</a></div>
      </article>)}</div>
    </section>}
    <DiscussionThread contextType="work" contextId={work.id} title="Discussion & questions"/>
  </main>;
}
