import { Reviews } from "./Reviews";
import { AddToShelf } from "./Shelves";
import { BookAudio } from "./Audio";
import { saveEpubOffline, downloadBook, exportReadingData, downloadCoveBackup } from "./epub";
import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Plus,
  Check,
  Download,
  Globe,
  Hash,
  FileText,
  Star,
  Loader2,
  Heart,
  UserPlus,
  ShoppingCart,
  ShieldCheck,
  CreditCard,
} from "lucide-react";
import { toast } from "sonner";
import { api, useAccount, authorOf, readPath, authorPath, publisherPath, imprintPath, seriesPath, type CatalogBook } from "./client";
import { BookArt, BookCard, visitorId } from "./Store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
type RelatedRail = { key:string; title:string; requestId:string; personalized:boolean; books:CatalogBook[]; items:{productId:string;reason:string}[] };
type RelatedResponse = { rails: RelatedRail[] };
function RelatedBook({rail,book,index,visitor}:{rail:RelatedRail;book:CatalogBook;index:number;visitor:string}){
  const ref=useRef<HTMLDivElement|null>(null);
  useEffect(()=>{const node=ref.current,productId=book.productId;if(!node||!productId||!visitor)return;let sent=false;const fire=()=>{if(sent)return;sent=true;void api("/recommendations/event","POST",{type:"recommendation_impression",productId,visitorId:visitor,requestId:rail.requestId,position:index+1,surface:`book:${rail.key}`}).catch(()=>{});};if(!("IntersectionObserver" in window)){fire();return;}const observer=new IntersectionObserver((entries)=>{if(entries.some((entry)=>entry.isIntersecting&&entry.intersectionRatio>=0.5)){fire();observer.disconnect();}},{threshold:[0.5]});observer.observe(node);return()=>observer.disconnect();},[rail.requestId,rail.key,book.productId,index,visitor]);
  const reason=rail.items.find((x)=>x.productId===book.productId)?.reason;
  return <div ref={ref} className="recommendation-card-wrap"><BookCard book={book} onOpen={()=>{if(book.productId)void api("/recommendations/event","POST",{type:"recommendation_click",productId:book.productId,visitorId:visitor,requestId:rail.requestId,position:index+1,surface:`book:${rail.key}`}).catch(()=>{});}}/>{reason&&<p className="recommendation-reason">{reason}</p>}</div>;
}
function RelatedRailView({rail,visitor}:{rail:RelatedRail;visitor:string}){if(!rail.books.length)return null;return <section className="recommendation-rail book-recommendation-rail"><div className="merch-rail-heading"><div><span className="small-label">{rail.personalized?"PERSONALIZED":"DISCOVER MORE"}</span><h2>{rail.title}</h2></div></div><div className="book-grid merch-grid">{rail.books.map((book,index)=><RelatedBook key={String(book.productId||book.id)} rail={rail} book={book} index={index} visitor={visitor}/>)}</div></section>;}

type ProductDetail = {
  book:CatalogBook;
  commerce:{territory:string;offer:null|{id:string;type:string;currency:string;amountMinor:number;listAmountMinor:number;promotion?:null|{id:string;campaignId:string|null;name:string;type:string;endsAt:string}};available:boolean;entitled:boolean;canReadFull:boolean;publicDomain:boolean;source:string;preorder:null|{accepting:boolean;reason:string|null;opensAt:string|null;releaseAt:string|null;manuscriptDeadlineAt:string|null;paymentTiming:string;priceGuaranteePolicy:string;cancellationPolicy:string;status:string;existing:null|{id:string;status:string;guaranteedPriceMinor:number;currency:string;createdAt:string}}};
  ratings:{average:number;count:number;distribution:Record<string,number>};
  rankings:{ranking_scope:string;ranking_key:string;rank:number;window:string}[];
  taxonomy:{id:string;name:string;path:string;depth:number;is_primary:number}[];
  preview:{available:boolean;policy:any};
  wishlist:{saved:boolean;alerts:any};
  distribution:{drmStatus:string;downloadable:boolean;fileSizeBytes:number|null;epubVersion:string|null;assetVersion:number|null};
  contentDisclosure:null|{policyVersion:string;textOrigin:string;coverOrigin:string;narrationOrigin:string;translationOrigin:string;syntheticVoiceLabel:string;publicBadges:{key:string;label:string}[]};
  editions:{editionId:string;externalBookId:string;productId:string;language:string;editionNumber:string;publicationDate?:string|null;releaseDate?:string|null;format:string;publisher:string;imprint:string;offer:any;current:boolean}[];
};
function money(amount:number,currency:string){try{return new Intl.NumberFormat(undefined,{style:"currency",currency}).format(amount/100);}catch{return `${currency} ${(amount/100).toFixed(2)}`;}}
function dateLabel(value?:string){if(!value)return "";const d=new Date(value);return Number.isNaN(d.valueOf())?value:new Intl.DateTimeFormat(undefined,{year:"numeric",month:"long",day:"numeric"}).format(d);}
function bytesLabel(value?:number|null){if(!value)return "—";if(value<1024*1024)return `${Math.round(value/1024)} KB`;return `${(value/1024/1024).toFixed(1)} MB`;}
function humanToken(value:unknown){return String(value||"unknown").replace(/_/g," ").replace(/\b\w/g,m=>m.toUpperCase());}
function yesNo(value:unknown){return Number(value)===1||value===true?"Yes":Number(value)===0||value===false?"No":"Not declared";}
function BookAccessibility({book}:{book:CatalogBook}){
  const a:any=book.accessibility;if(!a)return null;
  const cert=a.certification&&typeof a.certification==="object"?a.certification:{};
  const publisher=a.publisherDeclaration&&typeof a.publisherDeclaration==="object"?a.publisherDeclaration:{};
  return <section className="product-accessibility accessibility-disclosure" aria-labelledby="book-accessibility-heading">
    <ShieldCheck size={20}/><div className="accessibility-copy">
      <h3 id="book-accessibility-heading">Accessibility</h3>
      <p>{String(publisher.summary||a.summary||"Cove inspected this edition for accessibility metadata and structural support.")}</p>
      {publisher.knownLimitations&&<p className="small"><strong>Known limitations:</strong> {String(publisher.knownLimitations)}</p>}
      <dl className="accessibility-grid">
        <div><dt>Visual adjustments</dt><dd>{humanToken(a.visualAdjustments)}</dd></div>
        <div><dt>Nonvisual reading</dt><dd>{humanToken(a.nonvisualReading)}</dd></div>
        <div><dt>Image alternatives</dt><dd>{yesNo(a.altTextComplete)}</dd></div>
        <div><dt>Semantic structure</dt><dd>{yesNo(a.semanticStructure)}</dd></div>
        <div><dt>Reading order checked</dt><dd>{yesNo(a.readingOrderVerified)}</dd></div>
        <div><dt>Table semantics</dt><dd>{yesNo(a.tableSemanticsComplete)}</dd></div>
        <div><dt>MathML</dt><dd>{a.mathmlPresent?`Present · ${a.mathmlAccessible?"declared accessible":"review needed"}`:"Not detected"}</dd></div>
        <div><dt>Page navigation</dt><dd>{yesNo(a.pageNavigation)}</dd></div>
      </dl>
      {Array.isArray(a.features)&&a.features.length>0&&<p className="small muted"><strong>Declared features:</strong> {a.features.map(humanToken).join(" · ")}</p>}
      {Array.isArray(a.hazards)&&a.hazards.length>0&&<p className="small muted"><strong>Declared hazards:</strong> {a.hazards.map(humanToken).join(" · ")}</p>}
      {Array.isArray(a.conformsTo)&&a.conformsTo.length>0&&<p className="small muted"><strong>EPUB conformance metadata:</strong> {a.conformsTo.join(" · ")}</p>}
      {publisher.claimsConformance&&<p className="small muted"><strong>Publisher declaration:</strong> This edition is claimed conformant under the publisher’s signed accessibility declaration{publisher.policyVersion?` (${String(publisher.policyVersion)})`:""}.</p>}
      {(publisher.certifier||cert.certifier)&&<p className="small muted"><strong>Accessibility certifier:</strong> {String(publisher.certifier||cert.certifier)}{(publisher.credential||cert.credential)?` · ${String(publisher.credential||cert.credential)}`:""}</p>}
      <p className="small muted">Cove reports signed publisher declarations, EPUB metadata, and automated structural checks separately. Automated checks are evidence, not a guarantee for every assistive-technology combination.</p>
    </div>
  </section>;
}

function BookFormatSupport({book}:{book:CatalogBook}){const f:any=book.formatProfile;if(!f)return null;const features=[f.rtl&&"RTL reading",f.verticalWriting&&"Vertical writing",f.embeddedFonts&&"Embedded fonts",f.svg&&"SVG",f.mathml&&"MathML",f.complexTables&&"Tables",f.footnotes&&"Footnotes",f.endnotes&&"Endnotes",f.dictionaryContent&&"Dictionary semantics",f.accessibilityNavigation&&"Accessibility navigation"].filter(Boolean);return <section className="product-format-support" aria-labelledby="book-format-heading"><div><h3 id="book-format-heading">Reading format</h3><p><strong>{String(f.epubVersion||book.epubVersion||"EPUB")}</strong> · {humanToken(f.renditionLayout)} · {humanToken(f.readerSupport||"supported_with_limits")}</p>{features.length>0&&<p className="small muted">{features.join(" · ")}</p>}{Array.isArray(f.warnings)&&f.warnings.length>0&&<ul className="format-warning-list">{f.warnings.map((w:any,i:number)=><li key={i}>{String(w)}</li>)}</ul>}</div></section>}

export function BookPage({ id }: { id: string }) {
  const detail = useQuery<ProductDetail>({queryKey:["product-detail",id],queryFn:()=>api(`/books/${encodeURIComponent(id)}/detail`)});
  const b=detail.data?.book;
  const [recVisitor,setRecVisitor]=useState("");useEffect(()=>{setRecVisitor(visitorId());},[]);
  const related=useQuery<RelatedResponse>({queryKey:["book-recommendations",id,recVisitor],queryFn:()=>api(`/recommendations/book?bookId=${encodeURIComponent(id)}&visitor=${encodeURIComponent(recVisitor)}`),enabled:!!recVisitor&&!!b?.productId,staleTime:5*60_000,retry:1});
  useEffect(()=>{if(recVisitor&&b?.productId){void api("/recommendations/event","POST",{type:"book_view",productId:b.productId,visitorId:recVisitor,surface:"book-detail"}).catch(()=>{});void api("/events","POST",{eventType:"product_viewed",anonymousId:recVisitor,productId:b.productId,externalBookId:String(b.sourceExternalId||b.id),sourceSurface:"book-detail",dedupeKey:`product-view:${recVisitor}:${b.productId}:${Math.floor(Date.now()/1800000)}`}).catch(()=>{});}},[recVisitor,b?.productId,b?.id]);
  const promotionImpressionId=useRef(typeof crypto!=="undefined"&&crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`);
  const promotionCampaignId=detail.data?.commerce.offer?.promotion?.campaignId||null;
  useEffect(()=>{if(recVisitor&&b?.productId&&promotionCampaignId)void api("/promotions/event","POST",{campaignId:promotionCampaignId,productId:b.productId,eventType:"impression",visitorId:recVisitor,eventId:promotionImpressionId.current,sourceSurface:"book-detail"}).catch(()=>{});},[recVisitor,b?.productId,promotionCampaignId]);
  const {data,reload,signIn}=useAccount();
  const recommendationAccount=useQuery<{privacy:any;following:string[];wishlist:string[]}>({queryKey:["recommendation-account",data.user?.id],queryFn:()=>api("/recommendations/account"),enabled:!!data.user,staleTime:60_000});
  const entry=data.library.find(x=>x.productId===b?.productId||x.book.publicProductId===b?.publicProductId||x.bookId===id||x.bookId===b?.sourceExternalId||x.bookId===String(b?.id||"")),[busy,setBusy]=useState("");
  if(detail.isLoading)return <div className="empty-state"><Loader2 className="spin"/><p>Opening the book…</p></div>;
  if(!detail.data||!b)return <div className="empty-state"><h2>This book couldn’t be opened.</h2><p>{detail.error?.message}</p><button className="button gold" onClick={()=>detail.refetch()}>Try again</button></div>;
  const d=detail.data,offer=d.commerce.offer,preorder=d.commerce.preorder,wishlisted=d.wishlist.saved||(recommendationAccount.data?.wishlist||[]).includes(b.productId||"");
  async function save(input:any={}){if(!data.user)return signIn();try{await api("/library","POST",{bookId:id,...input});await Promise.all([reload(),detail.refetch()]);toast.success("Library updated");}catch(e){toast.error((e as Error).message);}}
  async function download(kind:"book"|"data"|"backup"){
    if((kind==="data"||kind==="backup")&&!data.user)return signIn();
    if(kind==="backup"&&!window.confirm("Create a private Cove backup? This ZIP will contain the ebook together with your highlights, notes, vocabulary, reading positions, and reading history. Do not share it as if it were only a book file."))return;
    setBusy(kind);try{if(kind==="book")await downloadBook(b);else if(kind==="data")await exportReadingData(b);else await downloadCoveBackup(b);toast.success(kind==="book"?"Book downloaded":kind==="data"?"Reading data exported":"Private backup created");}catch(e){toast.error((e as Error).message);}finally{setBusy("");}
  }
  async function promotionEvent(eventType:"click"|"wishlist"|"cart"){if(!offer?.promotion?.campaignId||!b.productId||!recVisitor)return;void api("/promotions/event","POST",{campaignId:offer.promotion.campaignId,productId:b.productId,eventType,visitorId:recVisitor,eventId:`${eventType}-${crypto.randomUUID()}`,sourceSurface:"book-detail"}).catch(()=>{});}
  async function wishlist(){if(!data.user)return signIn();if(!b.productId)return;try{await api("/wishlist/item","POST",{productId:b.productId,saved:!wishlisted,sourceSurface:"book-detail",territory:d.commerce.territory});if(!wishlisted)await promotionEvent("wishlist");await Promise.all([detail.refetch(),recommendationAccount.refetch()]);toast.success(!wishlisted?"Added to wishlist":"Removed from wishlist");}catch(e){toast.error((e as Error).message);}}
  async function cart(goCheckout=false){if(!data.user)return signIn();if(!b.productId)return;setBusy(goCheckout?"buy":"cart");try{await promotionEvent("click");await api("/cart/item","POST",{productId:b.productId,territory:d.commerce.territory,sourceSurface:goCheckout?"buy-now":"book-detail"});await promotionEvent("cart");if(goCheckout){location.assign("/checkout");return;}toast.success(preorder?"Preorder added to cart":"Added to cart",{action:{label:"View cart",onClick:()=>location.assign("/cart")}});}catch(e){toast.error((e as Error).message);}finally{setBusy("");}}
  async function cancelPreorder(){if(!preorder?.existing)return;setBusy("cancel-preorder");try{await api(`/preorders/${encodeURIComponent(preorder.existing.id)}/cancel`,"POST",{});toast.success("Preorder cancellation requested; the refund will be processed through the original payment method.");await detail.refetch();}catch(e){toast.error((e as Error).message);}finally{setBusy("");}}
  return <>
    <a href="/" className="text-link back-link"><ArrowLeft size={16}/> Back to bookstore</a>
    <div className="book-detail commercial-product-detail">
      <div className="detail-art">
        <BookArt book={b}/>
        <div className="detail-source">{b.uploaded?"YOUR PERSONAL EPUB":d.commerce.publicDomain?"PROJECT GUTENBERG EDITION":b.publisher?`${b.publisher} EDITION`:"FORE EBOOK EDITION"}</div>
        {d.rankings.length>0&&<div className="product-rankings">{d.rankings.slice(0,3).map(r=><div key={`${r.ranking_scope}:${r.ranking_key}:${r.window}`}><strong>#{r.rank}</strong><span>{r.ranking_key||r.ranking_scope}</span></div>)}</div>}
      </div>
      <div className="detail-main">
        <span className="page-eyebrow">{d.commerce.entitled?"IN YOUR ACCOUNT":d.commerce.publicDomain?"FREE TO READ · FREE TO KEEP":preorder?.existing?`PREORDERED · RELEASES ${dateLabel(preorder.releaseAt||undefined).toUpperCase()}`:preorder?.accepting?"AVAILABLE FOR PREORDER":preorder?"COMING SOON":"DIGITAL EDITION"}</span>
        <h1>{b.title}</h1>{b.subtitle&&<p className="product-subtitle">{b.subtitle}</p>}
        <p className="detail-author">{b.authors?.length?b.authors.map((author,index)=><span key={`${author.id||author.name}:${index}`}>{index?", ":""}{author.id?<a href={authorPath(author)}>{authorOf({...b,authors:[author]})}</a>:authorOf({...b,authors:[author]})}</span>):"Unknown author"}</p>
        {(b.series?.length||b.publisher||b.imprint)&&<div className="detail-commerce-links">{b.series?.map(series=><a key={series.id} href={seriesPath(series)}>{series.name}{series.readingOrder?` · #${series.readingOrder}`:series.position?` · #${series.position}`:""}{series.relationship&&series.relationship!=="main"?` · ${series.relationship}`:""}</a>)}{b.publisher&&(b.publisherId?<a href={publisherPath(b)}>{b.publisher}</a>:<span>{b.publisher}</span>)}{b.imprint&&(b.imprintId?<a href={imprintPath(b)}>{b.imprint} imprint</a>:<span>{b.imprint} imprint</span>)}</div>}
        {d.ratings.count>0&&<a className="product-rating-summary" href="#reviews"><Star size={17} fill="currentColor"/><strong>{d.ratings.average.toFixed(1)}</strong><span>{d.ratings.count.toLocaleString()} rating{d.ratings.count===1?"":"s"}</span></a>}
        <div className="detail-badges"><span><Globe size={14}/>{b.languages.join(", ").toUpperCase()}</span><span><FileText size={14}/> EPUB</span>{b.isbn13&&<span><Hash size={14}/> ISBN {b.isbn13}</span>}</div>
        {!b.uploaded&&<div className="commerce-buy-box">
          <div className="commerce-price">{offer?<>{offer.promotion&&offer.listAmountMinor>offer.amountMinor&&<del>{money(offer.listAmountMinor,offer.currency)}</del>}<strong>{offer.amountMinor===0?"Free":money(offer.amountMinor,offer.currency)}</strong>{offer.promotion&&<span>{offer.promotion.name}{offer.promotion.endsAt?` · ends ${dateLabel(offer.promotion.endsAt)}`:""}</span>}</>:<><strong>Currently unavailable</strong><span>No active retail offer for {d.commerce.territory}.</span></>}</div>
          <div className="detail-actions">
            {d.commerce.canReadFull&&<a href={readPath(id)} className="button gold"><BookOpen size={18}/>{entry?.cfi?"Continue reading":"Read now"}</a>}
            {!d.commerce.canReadFull&&d.preview.available&&<a href={`${readPath(id)}?preview=1`} className="button gold"><BookOpen size={18}/>Preview</a>}
            {!d.commerce.canReadFull&&preorder?.existing&&<><button className="button gold" disabled><Check size={17}/> Preordered</button>{preorder.existing.status==="paid_pending_release"&&preorder.cancellationPolicy==="customer_until_release"&&<button className="button outline" disabled={busy==="cancel-preorder"} onClick={cancelPreorder}>{busy==="cancel-preorder"?<Loader2 className="spin" size={17}/>:null} Cancel preorder</button>}</>}
            {!d.commerce.canReadFull&&offer&&offer.amountMinor>0&&!preorder?.existing&&(!preorder||preorder.accepting)&&<><button className="button gold" disabled={busy==="buy"} onClick={()=>cart(true)}>{busy==="buy"?<Loader2 className="spin" size={17}/>:<CreditCard size={17}/>} {preorder?"Preorder now":"Buy now"}</button><button className="button outline" disabled={busy==="cart"} onClick={()=>cart(false)}>{busy==="cart"?<Loader2 className="spin" size={17}/>:<ShoppingCart size={17}/>} {preorder?"Add preorder to cart":"Add to cart"}</button></>}
            {!d.commerce.canReadFull&&preorder&&!preorder.existing&&!preorder.accepting&&<button className="button outline" disabled>{preorder.reason==="not_open"&&preorder.opensAt?`Preorders open ${dateLabel(preorder.opensAt)}`:"Preorders unavailable"}</button>}
            {d.commerce.canReadFull&&<button className="button outline" onClick={()=>save()} disabled={!!entry}>{entry?<Check size={18}/>:<Plus size={18}/>} {entry?"In your library":"Add to library"}</button>}
            <button className="button outline" onClick={wishlist}><Heart size={17} fill={wishlisted?"currentColor":"none"}/> {wishlisted?"Wishlisted":"Add to wishlist"}</button>
            {d.commerce.canReadFull&&<AddToShelf bookId={id}/>} 
          </div>
          {preorder&&<p className="commerce-fineprint">{preorder.existing?`Your preorder is reserved at ${money(preorder.existing.guaranteedPriceMinor,preorder.existing.currency)} and will unlock automatically on ${dateLabel(preorder.releaseAt||undefined)}.`:`Cove charges this preorder at checkout; reading entitlement is granted only at release${preorder.priceGuaranteePolicy==="lowest_price"?", and qualifying price drops before release are refunded automatically":""}.`} {preorder.cancellationPolicy==="customer_until_release"?"You may cancel before release under the preorder policy.":"Cancellation is governed by the displayed preorder policy."}</p>}
          {d.preview.available&&!d.commerce.canReadFull&&<p className="commerce-fineprint">The sample is generated as a separate, limited EPUB. Buying or otherwise acquiring this edition carries your last sample location into the full book.</p>}
        </div>}
        {b.uploaded&&<div className="detail-actions"><a href={readPath(id)} className="button gold"><BookOpen size={18}/>{entry?.cfi?"Continue reading":"Read now"}</a><AddToShelf bookId={id}/></div>}
        {b.authors?.[0]?.id&&<button className="text-link follow-author-link" onClick={async()=>{if(!data.user)return signIn();const contributorId=b.authors[0].id!,follow=!(recommendationAccount.data?.following||[]).includes(contributorId);try{await api("/authors/follow","POST",{contributorId,follow});await recommendationAccount.refetch();toast.success(follow?"Author followed":"Author unfollowed");}catch(e){toast.error((e as Error).message);}}}><UserPlus size={16}/> {(recommendationAccount.data?.following||[]).includes(b.authors[0].id!)?"Following author":"Follow author"}</button>}
        <section className="book-summary"><h2>About this book</h2><p>{b.publisherDescription||b.summaries?.[0]||"Explore this edition in Cove's reader."}</p></section>
        {d.contentDisclosure?.publicBadges?.length>0&&<section className="product-accessibility content-transparency"><ShieldCheck size={20}/><div><h3>Content transparency</h3><p>{d.contentDisclosure.publicBadges.map(x=>x.label).join(" · ")}. <a href="/publishing-policy">Read Cove's AI & automated content policy</a>.</p></div></section>}
        {d.taxonomy.length>0&&<div className="subject-list commercial-taxonomy">{d.taxonomy.slice(0,10).map(t=><a key={t.id} href={`/ebooks/${t.path}`}>{t.name}</a>)}</div>}
        {b.publicWorkId&&<p className="work-editions-link"><a className="text-link" href={`/work/${encodeURIComponent(b.publicWorkId)}`}>View this work and all editions <ArrowUpRight size={14}/></a></p>}
        <section className="product-facts"><h2>eBook details</h2><div className="product-facts-grid">
          <div><span>Publisher</span><strong>{b.imprint&&b.imprintId?<a href={imprintPath(b)}>{b.imprint}</a>:b.publisher&&b.publisherId?<a href={publisherPath(b)}>{b.publisher}</a>:b.imprint||b.publisher||"—"}</strong></div><div><span>Release date</span><strong>{dateLabel(b.releaseDate||b.publicationDate)||"—"}</strong></div>
          <div><span>ISBN</span><strong>{b.isbn13||"—"}</strong></div><div><span>Language</span><strong>{b.languages.join(", ").toUpperCase()}</strong></div>
          <div><span>Length</span><strong>{b.pageEstimate?`${b.pageEstimate.toLocaleString()} pages`:b.wordCount?`${b.wordCount.toLocaleString()} words`:"—"}</strong></div><div><span>Reading time</span><strong>{b.readingTimeMinutes?`${Math.round(b.readingTimeMinutes/60)} hr ${b.readingTimeMinutes%60} min`:"—"}</strong></div>
          <div><span>File</span><strong>{d.distribution.epubVersion?`EPUB ${d.distribution.epubVersion}`:"EPUB"} · {bytesLabel(d.distribution.fileSizeBytes)}</strong></div><div><span>Protection</span><strong>{d.distribution.drmStatus==="none"?"DRM-free":d.distribution.drmStatus}</strong></div>
          <div><span>Layout</span><strong>{b.layout||"Reflowable"}</strong></div><div><span>Edition</span><strong>{b.editionId?<a href={`/edition/${encodeURIComponent(b.editionId)}`}>{b.editionNumber||"Edition details"}</a>:b.editionNumber||"—"}</strong></div><div><span>Download</span><strong>{d.distribution.downloadable?"Available with entitlement":"Cove reader only"}</strong></div>
        </div></section>
        <BookAccessibility book={b}/>
        <BookFormatSupport book={b}/>
        {d.commerce.canReadFull&&<div className="download-panel separated-downloads"><div><Download size={22}/><div><h3>Downloads & exports</h3><p>Book content and private reading data are intentionally separate.</p></div></div><div className="download-split-grid"><div><strong>Download book</strong><p className="small muted">The licensed/public-domain EPUB only. No highlights, notes, vocabulary, or history.</p>{d.distribution.downloadable?<button className="button outline" disabled={!!busy} onClick={()=>download("book")}>{busy==="book"?<Loader2 size={16} className="spin"/>:<Download size={16}/>} Download EPUB</button>:<span className="export-unavailable">Publisher license: Cove reader only</span>}</div><div><strong>Export reading data</strong><p className="small muted">Your highlights, notes, dictionary words, positions, and reading history. No ebook file.</p><button className="button outline" disabled={!!busy} onClick={()=>download("data")}>{busy==="data"?<Loader2 size={16} className="spin"/>:<FileText size={16}/>} Export private data</button></div><div className="private-backup-option"><strong>Cove backup package</strong><p className="small muted"><b>Private:</b> combines the EPUB and your personal reading data. Review before sharing.</p>{d.distribution.downloadable?<button className="button outline" disabled={!!busy} onClick={()=>download("backup")}>{busy==="backup"?<Loader2 size={16} className="spin"/>:<ShieldCheck size={16}/>} Create private backup</button>:<span className="export-unavailable">Unavailable because this edition cannot be exported as an EPUB.</span>}</div></div>{d.commerce.publicDomain&&<button className="text-link" disabled={!!busy} onClick={async()=>{setBusy("offline");try{await saveEpubOffline(b,data.user?.id||"");toast.success("Book saved for offline reading");}catch(e){toast.error((e as Error).message);}finally{setBusy("");}}}>Save offline in Cove</button>}</div>}
        {d.commerce.publicDomain&&!b.uploaded&&b.sourceUrl&&<a className="text-link" target="_blank" rel="noreferrer" href={b.sourceUrl}>View source edition{b.sourceProject?` · ${b.sourceProject}`:""} <ArrowUpRight size={14}/></a>}
        {d.editions?.length>1&&<section className="other-editions"><div className="section-heading"><div><span className="small-label">THIS WORK</span><h2>Other editions</h2></div></div><div className="edition-list">{d.editions.map(e=><a key={e.editionId} className={`edition-row ${e.current?"current":""}`} href={`/edition/${encodeURIComponent(e.editionId)}`}><div><strong>{e.current?"Current edition":e.editionNumber||e.publisher||"Digital edition"}</strong><span>{[e.publisher,e.imprint,e.language?.toUpperCase(),dateLabel(e.releaseDate||e.publicationDate||undefined)].filter(Boolean).join(" · ")}</span></div><div>{e.offer?<strong>{money(e.offer.amountMinor,e.offer.currency)}</strong>:<span className="muted">Unavailable</span>}</div></a>)}</div></section>}
        <BookAudio book={b}/>
        {entry&&<section className="personal-review"><h2>Your reading record</h2><div className="record-row"><Select value={entry.status} onValueChange={status=>save({status})}><SelectTrigger aria-label="Reading status"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="want-to-read">Want to read</SelectItem><SelectItem value="reading">Currently reading</SelectItem><SelectItem value="finished">Finished</SelectItem></SelectContent></Select></div></section>}
      </div>
    </div>
    {!b.uploaded&&recVisitor&&(related.data?.rails||[]).map(rail=><RelatedRailView key={`${rail.key}:${rail.requestId}`} rail={rail} visitor={recVisitor}/>)}
    <div id="reviews"><Reviews bookId={id} personal={!!b.uploaded}/></div>
  </>;
}

