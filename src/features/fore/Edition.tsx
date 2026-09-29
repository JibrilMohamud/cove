import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Loader2 } from "lucide-react";
import { api } from "./client";
import { BookPage } from "./Book";

type EditionResolve={
  externalBookId:string; publicProductId:string; workId:string;
  edition:{
    title:string; subtitle:string; format:string; language:string; editionNumber:string; isbn13:string;
    publicationDate:string|null; releaseDate:string|null; editionType:string; differentiationStatus:string; differentiationSummary:string; canonicalPublicDomain:boolean;
    publisher:null|{id:string;name:string;slug:string};
    imprint:null|{id:string;name:string;slug:string};
    contributors:{id:string;name:string;slug:string;role:string;position:number}[];
  };
  otherEditions:any[];
};

function humanFormat(value:string){return value.toLowerCase()==="ebook"?"eBook":value.charAt(0).toUpperCase()+value.slice(1)}

export function EditionPage({id}:{id:string}){
  const q=useQuery<EditionResolve>({queryKey:["edition-resolve",id],queryFn:()=>api(`/editions/${encodeURIComponent(id)}/resolve`),retry:1});
  useEffect(()=>{
    if(!q.data||typeof document==="undefined")return;
    document.title=`${q.data.edition.title} — edition | Cove`;
    let canonical=document.head.querySelector<HTMLLinkElement>('link[rel="canonical"][data-fore-edition]');
    if(!canonical){canonical=document.createElement("link");canonical.rel="canonical";canonical.setAttribute("data-fore-edition","1");document.head.appendChild(canonical);}
    canonical.href=new URL(`/edition/${encodeURIComponent(id)}`,window.location.origin).href;
    return()=>{document.head.querySelectorAll('[data-fore-edition="1"]').forEach(n=>n.remove());};
  },[q.data,id]);
  if(q.isLoading)return <div className="empty-state"><Loader2 className="spin"/><p>Opening this edition…</p></div>;
  if(!q.data)return <div className="empty-state"><h2>This edition could not be opened.</h2><p>{q.error?.message}</p></div>;
  const e=q.data.edition,credits=e.contributors.filter(x=>x.role==="author").map(x=>x.name).join(", ");
  return <>
    <aside className="edition-route-context" aria-label="Edition identity">
      <FileText size={18}/><div><span className="small-label">EDITION RECORD</span><strong>{e.canonicalPublicDomain?"Canonical free edition":e.editionNumber||humanFormat(e.format)}</strong><p>{[credits,e.imprint?.name||e.publisher?.name,e.language.toUpperCase(),e.isbn13?`ISBN ${e.isbn13}`:""].filter(Boolean).join(" · ")}</p></div>
      <a href={`/work/${encodeURIComponent(q.data.workId)}`} className="text-link">See all editions</a>
    </aside>
    <BookPage id={q.data.publicProductId||q.data.externalBookId}/>
  </>;
}
