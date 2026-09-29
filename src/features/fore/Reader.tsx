import {openBiosync,resolveAudio,resolveText,matchingEpub} from "./biosync-client";
import { Headphones } from "lucide-react";
import { createActivity, measureEpub } from "./reading-activity";
import { sha256 } from "./offline";
import { loadEdition } from "./audio-client";
import { cueForAudio, type AudioEdition } from "./domain";
import { loadBookMetadata } from "./epub";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  BookOpen,
  List,
  Settings2,
  Highlighter,
  BookA,
  Pencil,
  X,
  Bookmark,
  Search,
  Loader2,
  Check,
  Sun,
  Moon,
  Users,
  MessageCircle,
  Share2,
  Eye,
} from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, useAccount, colors, type CatalogBook, type Annotation, type TextBookmark } from "./client";
import { ensureSyncClient, loadSyncedReaderSettings, saveSyncedReaderSetting } from "./sync-client";
import { epubBytes, prepareEpub } from "./epub";
import { DictionaryLookup } from "./Collections";
type Selection = { text: string; cfi: string; chapter: string };
type Toc = {
  id: string;
  href: string;
  label: string;
  subitems?: Toc[];
  cfi?: string;
  spineIndex?: number;
};
function flatten(items: Toc[]): Toc[] {
  return items.flatMap((i) => [i, ...flatten(i.subitems || [])]);
}
// Gutenberg's EPUB Contents anchors are the authoritative links; only the noisy
// labels are normalized so nearby image transcriptions never become chapter names.
function cleanGutenbergLabel(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  const chapter =
    text.match(/\bchapter\s*([ivxlcdm]+|\d+|[a-z]+)\b\.?/i) ||
    text.match(/\bchapter([ivxlcdm]+|\d+)\b\.?/i);
  if (chapter) return "Chapter " + chapter[1].replace(/[.]$/, "") + ".";
  const section = text.match(
    /\b(prologue|epilogue|preface|introduction|appendix|part|book)\b(?:\s+([ivxlcdm]+|\d+|[a-z]+))?/i,
  );
  if (section)
    return section[2]
      ? section[1][0].toUpperCase() + section[1].slice(1).toLowerCase() + " " + section[2] + "."
      : section[1][0].toUpperCase() + section[1].slice(1).toLowerCase();
  return text;
}
function cleanToc(items: Toc[]) {
  const flat = flatten(items)
    .map((item, i) => ({
      ...item,
      id: item.id || String(i),
      label: cleanGutenbergLabel(String(item.label || "")),
    }))
    .filter(
      (item) =>
        item.label &&
        !/^(contents|table of contents|the full project gutenberg|project gutenberg|copyright|license)/i.test(
          item.label,
        ),
    );
  const chapters = flat.filter((item) => /^Chapter\s/i.test(item.label));
  return chapters.length ? chapters : flat;
}
async function resolveTocCFIs(book: any, items: Toc[]) {
  const grouped = new Map<any, Toc[]>();
  for (const item of items) {
    const [href] = item.href.split("#");
    const section = book.spine.get(href);
    if (!section) continue;
    item.spineIndex = section.index;
    const list = grouped.get(section) || [];
    list.push(item);
    grouped.set(section, list);
  }
  for (const [section, list] of grouped) {
    try {
      await section.load(book.load.bind(book));
      for (const item of list) {
        const fragment = item.href.split("#")[1];
        if (!fragment) continue;
        const element = section.document?.getElementById(decodeURIComponent(fragment));
        if (element) item.cfi = section.cfiFromElement(element);
      }
    } catch {
    } finally {
      section.unload();
    }
  }
  return items;
}
function chapterForLocation(loc: any, items: Toc[], CFI: any) {
  if (!loc?.start?.cfi) return "Reading";
  const before = CFI
    ? items.filter((item) => item.cfi && new CFI().compare(item.cfi, loc.start.cfi) <= 0)
    : [];
  if (before.length) return before[before.length - 1].label;
  const href = String(loc.start.href || "").split("#")[0];
  return items.find((item) => item.href.split("#")[0] === href)?.label || "Reading";
}
const themes = {
  paper: { bg: "#f5f2ea", fg: "#262a2e" },
  sepia: { bg: "#ece0c9", fg: "#3d342a" },
  night: { bg: "#15202e", fg: "#d8dee7" },
  oled: { bg: "#000000", fg: "#d6d7d9" },
};
export function ReaderPage({ id }: { id: string }) {
  const previewMode = new URLSearchParams(window.location.search).get("preview") === "1";
  const bookQuery = useQuery<CatalogBook>({
    queryKey: ["book", id],
    queryFn: () => loadBookMetadata(id),
  });
  const { data, loading: accountLoading, reload, signIn } = useAccount();
  const activity = useRef<ReturnType<typeof createActivity> | null>(null),
    epubHash = useRef(""),sync=useRef<Awaited<ReturnType<typeof openBiosync>>|null>(null),syncEdition=useRef<AudioEdition|null>(null),initialAnchor=useRef(""),anchorPage=useRef(""),syncConflict=useRef(false);
  const editions = useQuery<{ results: AudioEdition[] }>({
    queryKey: ["book-audio", id],
    queryFn: () => api("/audiobooks?bookId=" + id),
  });
  const container = useRef<HTMLDivElement>(null),
    rendition = useRef<any>(null),
    epub = useRef<any>(null),
    mounted = useRef(false),
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    position = useRef({ cfi: "", progress: 0 }),
    accountRef = useRef(data),
    chapterRef = useRef(""),
    annotationRef = useRef(data.annotations),
    savingPosition = useRef(Promise.resolve()),
    recommendationStart = useRef(""),
    recommendationProgressBucket = useRef(-1),
    readingVersion = useRef(0),
    previewVersion = useRef(0),
    settingVersions = useRef<Record<string,number>>({}),
    lastSyncedSettings = useRef<Record<string,unknown>>({}),
    settingSyncReady = useRef(false),
    settingSaveTimer = useRef<ReturnType<typeof setTimeout>|null>(null),
    chromeHideTimer = useRef<ReturnType<typeof setTimeout>|null>(null),
    chromeVisibleRef = useRef(false);
  accountRef.current = data;
  annotationRef.current = data.annotations;
  useEffect(()=>{readingVersion.current=data.library.find((x)=>x.bookId===id)?.version||0;},[data.library,id]);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [toc, setToc] = useState<Toc[]>([]),
    [chapter, setChapter] = useState(""),
    [percent, setPercent] = useState(0),
    [panel, setPanel] = useState(""),
    [selection, setSelection] = useState<Selection | null>(null),
    [color, setColor] = useState("yellow"),
    [note, setNote] = useState(""),
    [noteOpen, setNoteOpen] = useState(false),
    [dictionary, setDictionary] = useState<Selection | null>(null),
    [fontSize, setFontSize] = useState(19),
    [lineHeight, setLineHeight] = useState(1.65),
    [font, setFont] = useState("publisher"),
    [theme, setTheme] = useState<keyof typeof themes>("paper"),
    [flow, setFlow] = useState("paginated"),
    [query, setQuery] = useState(""),
    [matches, setMatches] = useState<any[]>([]),
    [searching, setSearching] = useState(false),
    [saving, setSaving] = useState(false),
    [saveState, setSaveState] = useState(""),
    [activeAnnotation, setActiveAnnotation] = useState<Annotation | null>(null),
    [socialCompose,setSocialCompose]=useState<"discussion"|"share"|null>(null),
    [socialBody,setSocialBody]=useState(""),
    [socialVisibility,setSocialVisibility]=useState<"public"|"followers"|"friends"|"group">("friends"),
    [socialShareNote,setSocialShareNote]=useState(false),
    [socialAnnotationId,setSocialAnnotationId]=useState<string|null>(null),
    [socialBusy,setSocialBusy]=useState(false),
    [activeSocial,setActiveSocial]=useState<any|null>(null),
    [finishedJourney,setFinishedJourney]=useState<string|null>(null),
    [chromeVisible,setChromeVisible]=useState(false),
    [formatInfo,setFormatInfo]=useState<{fixedLayout:boolean;rtl:boolean;verticalWriting:boolean;epubVersion:string;navigationType:string;pageProgressionDirection:string}>({fixedLayout:false,rtl:false,verticalWriting:false,epubVersion:"EPUB",navigationType:"unknown",pageProgressionDirection:"default"});
  const formatRef=useRef(formatInfo); formatRef.current=formatInfo;
  chromeVisibleRef.current=chromeVisible;

  function cancelChromeHide(){
    if(chromeHideTimer.current){clearTimeout(chromeHideTimer.current);chromeHideTimer.current=null;}
  }
  function hideChrome(){
    cancelChromeHide();
    chromeVisibleRef.current=false;
    setChromeVisible(false);
  }
  function scheduleChromeHide(delay=4200){
    cancelChromeHide();
    chromeHideTimer.current=setTimeout(()=>{
      chromeHideTimer.current=null;
      chromeVisibleRef.current=false;
      setChromeVisible(false);
    },delay);
  }
  function showChrome(autoHide=true){
    chromeVisibleRef.current=true;
    setChromeVisible(true);
    if(autoHide)scheduleChromeHide();
    else cancelChromeHide();
  }
  function toggleChrome(){
    if(chromeVisibleRef.current) hideChrome();
    else showChrome();
  }
  useEffect(()=>()=>{
    if(chromeHideTimer.current)clearTimeout(chromeHideTimer.current);
  },[]);
  const socialReader=useQuery<any>({
    queryKey:["social-reader",id,data.user?.id,percent,chapter],
    queryFn:()=>api(`/social/reader/${encodeURIComponent(id)}?progress=${Math.max(0,Math.min(1,position.current.progress||percent/100))}&chapter=${encodeURIComponent(chapter||"")}`),
    enabled:!!data.user&&!previewMode,
    staleTime:4000,
    refetchOnWindowFocus:false,
  });
  const socialAccount=useQuery<any>({queryKey:["social-me-reader",data.user?.id],queryFn:()=>api("/social/me"),enabled:!!data.user&&!previewMode,staleTime:15000});
  const settings = useRef({ fontSize, lineHeight, font, theme });
  settings.current = { fontSize, lineHeight, font, theme };
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem("fore:epub-preferences") || "{}");
      if (p.fontSize >= 14 && p.fontSize <= 32) setFontSize(p.fontSize);
      if (p.lineHeight >= 1.2 && p.lineHeight <= 2.2) setLineHeight(p.lineHeight);
      if (["publisher", "serif", "sans-serif"].includes(p.font)) setFont(p.font);
      if (p.theme in themes) setTheme(p.theme);
      if (["paginated", "scrolled-doc"].includes(p.flow)) setFlow(p.flow);
    } catch {}
  }, []);
  useEffect(()=>{
    if(!data.user){settingSyncReady.current=false;settingVersions.current={};lastSyncedSettings.current={};return;}
    let canceled=false;
    (async()=>{
      try{
        const remote=await loadSyncedReaderSettings(data.user!.id);
        if(canceled)return;
        settingVersions.current=Object.fromEntries(Object.entries(remote.settings).map(([k,v])=>[k,v.version]));
        const seen:Record<string,unknown>={};
        const get=(key:string)=>remote.settings[key]?.value;
        if(typeof get("reader.fontSize")==="number"){setFontSize(get("reader.fontSize"));seen["reader.fontSize"]=get("reader.fontSize");}
        if(typeof get("reader.lineHeight")==="number"){setLineHeight(get("reader.lineHeight"));seen["reader.lineHeight"]=get("reader.lineHeight");}
        if(["publisher","serif","sans-serif"].includes(String(get("reader.font")))){setFont(String(get("reader.font")));seen["reader.font"]=get("reader.font");}
        if(String(get("reader.theme")) in themes){setTheme(String(get("reader.theme")) as keyof typeof themes);seen["reader.theme"]=get("reader.theme");}
        if(["paginated","scrolled-doc"].includes(String(get("reader.flow")))){setFlow(String(get("reader.flow")));seen["reader.flow"]=get("reader.flow");}
        lastSyncedSettings.current=seen;
        settingSyncReady.current=true;
      }catch{settingSyncReady.current=false;}
    })();
    return()=>{canceled=true;};
  },[data.user?.id]);
  function applySettings(r: any) {
    const s = settings.current,
      t = themes[s.theme];
    if(formatRef.current.fixedLayout) return;
    r.themes.default({
      body: {
        color: t.fg + " !important",
        background: t.bg + " !important",
        "line-height": String(s.lineHeight) + " !important",
      },
      a: {
        color:
          s.theme === "paper" || s.theme === "sepia" ? "#775726 !important" : "#e5c17c !important",
      },
      img: { "max-width": "100%", height: "auto" },
    });
    r.themes.fontSize(s.fontSize + "px");
    if (s.font === "publisher") r.themes.removeOverride("font-family");
    else r.themes.font(s.font);
  }
  async function persistPosition() {
    const p = position.current;
    if(!p.cfi)return;
    if(!previewMode&&syncEdition.current&&sync.current){try{const m=await resolveText(syncEdition.current,p.cfi,epubHash.current);if(m)await sync.current.save(syncEdition.current,m,"text");}catch(error){setSaveState((error as Error).message);if((error as any).status===409)syncConflict.current=true;}}
    if(!accountRef.current.user)return;
    setSaveState(previewMode?"Saving sample position…":"Saving position…");
    const snapshot = { ...p };
    savingPosition.current = savingPosition.current
      .catch(() => {})
      .then(async () => {
        try {
          if(previewMode){
            const productId=bookQuery.data?.productId;if(productId){const saved=await api<{version:number}>("/preview/state","POST",{productId,cfi:snapshot.cfi,progress:snapshot.progress,expectedVersion:previewVersion.current});previewVersion.current=saved.version;}
          }else {
            const saved=await api<{version:number;readingJourneyId?:string|null}>("/library", "POST", {
              bookId: id,
              status: snapshot.progress >= 0.995 ? "finished" : "reading",
              cfi: snapshot.cfi,
              progress: snapshot.progress,
              expectedVersion: readingVersion.current,
            });
            readingVersion.current=saved.version;
            if(saved.readingJourneyId&&mounted.current)setFinishedJourney(saved.readingJourneyId);
          }
          const productId=bookQuery.data?.productId,bucket=Math.floor(Math.max(0,Math.min(0.999,snapshot.progress))*10);
          if(productId&&bucket>0&&bucket>recommendationProgressBucket.current){
            recommendationProgressBucket.current=bucket;
            api("/recommendations/event","POST",{type:"read_progress",productId,value:snapshot.progress,surface:"reader",metadata:{progressBucket:bucket}}).catch(()=>{});
          }
          if (mounted.current) setSaveState("Position saved");
        } catch (e) {
          if((e as any)?.status===409){
            if(mounted.current)setSaveState("Position changed on another device — reload to choose");
            reload().catch(()=>{});
          } else if (mounted.current) setSaveState("Position not saved — retry");
        }
      });
    await savingPosition.current;
  }
  useEffect(() => {
    if (accountLoading || !container.current || !bookQuery.data) return;
    let canceled = false;
    mounted.current = true;
    setReady(false);
    setError("");
    let created: any;
    let resize: ResizeObserver | undefined;
    (async () => {
      const params=new URLSearchParams(location.search);
      if(!previewMode){
        sync.current=await openBiosync(id,accountRef.current.user?.id||null);
        const preferred=params.get('audioEdition')||sync.current.current?.edition_id;
        if(preferred){try{const e=await loadEdition(preferred);if(e.bookId===id&&e.alignment?.version===2)syncEdition.current=e;}catch{}}
        if(!syncEdition.current){try{const r=await api('/audiobooks?bookId='+id);syncEdition.current=r.results.find((e:AudioEdition)=>e.alignment?.version===2)||null;}catch{}}
      }
      const [{default:ePub},bytes]=await Promise.all([import('epubjs'),!previewMode&&syncEdition.current?matchingEpub(syncEdition.current):epubBytes(id,previewMode,data.user?.id||"")]);
      if (canceled) return;
      epubHash.current = await sha256(bytes);
      const clean = await prepareEpub(bytes);
      const detected={fixedLayout:!!clean.metadata.fixedLayout,rtl:!!clean.metadata.rtl,verticalWriting:!!clean.metadata.verticalWriting,epubVersion:String(clean.metadata.epubVersion||"EPUB"),navigationType:String(clean.metadata.navigationType||"unknown"),pageProgressionDirection:String(clean.metadata.pageProgressionDirection||"default")};
      formatRef.current=detected;setFormatInfo(detected);if(detected.fixedLayout&&flow!=="paginated")setFlow("paginated");
      if (accountRef.current.user && !previewMode)
        measureEpub(clean.metadata)
          .then((metrics) => api("/metrics", "PUT", { bookId: id, ...metrics }))
          .catch(() => {});
      activity.current = createActivity(id, accountRef.current.user?.id || null, "read");
      const recommendationProductId=bookQuery.data?.productId;
      if(accountRef.current.user&&recommendationProductId&&recommendationStart.current!==recommendationProductId){
        recommendationStart.current=recommendationProductId;recommendationProgressBucket.current=-1;
        api("/recommendations/event","POST",{type:previewMode?"sample_start":"read_start",productId:recommendationProductId,surface:previewMode?"preview":"reader"}).catch(()=>{});
      }
      if (canceled) return;
      created = ePub(clean.bytes, { replacements: "blobUrl" });
      epub.current = created;
      await created.ready;
      if (canceled) {
        created.destroy();
        return;
      }
      const nav = await created.loaded.navigation;
      const chapters = cleanToc(nav.toc);
      try {
        await resolveTocCFIs(created, chapters);
      } catch {}
      if (canceled) return;
      setToc(chapters);
      const r = created.renderTo(container.current!, {
        width: "100%",
        height: "100%",
        spread: detected.fixedLayout ? "auto" : "none",
        flow: detected.fixedLayout ? "paginated" : flow,
        allowScriptedContent: false,
        allowPopups: false,
        manager: "default",
      });
      rendition.current = r;
      if(detected.rtl&&typeof r.direction==="function")r.direction("rtl");
      applySettings(r);
      r.hooks.content.register((contents: any) => {
        contents.document.addEventListener("keydown", keys);
        contents.document.addEventListener("pointerdown", () => activity.current?.interact());
        contents.document.addEventListener("scroll", () => activity.current?.interact());
        contents.document.addEventListener("pointermove", (event: PointerEvent) => {
          const edge = 28;
          if (event.clientY <= edge || event.clientY >= contents.window.innerHeight - edge) showChrome();
        });
        contents.document.addEventListener("click", (event: Event) => {
          const anchor = (event.target as Element)?.closest?.("a");
          if (anchor && /^https?:/i.test(anchor.href)) {
            event.preventDefault();
            window.open(anchor.href, "_blank", "noopener,noreferrer");
            return;
          }
          if (anchor) return;
          const selectedText=contents.window.getSelection()?.toString().trim();
          if (!selectedText) toggleChrome();
        });
      });
      r.on("selected", (cfi: string, contents: any) => {
        const text = contents.window.getSelection()?.toString().trim();
        if (text) {
          setSelection({ cfi, text: text.slice(0, 12000), chapter: chapterRef.current });
          setActiveAnnotation(null);
        }
      });
      r.on("relocated", (loc: any) => {
        if (canceled) return;
        (async () => {
          try {
            const start = await created.getRange(loc.start.cfi),
              end = await created.getRange(loc.end.cfi);
            if (start.startContainer.ownerDocument === end.endContainer.ownerDocument) {
              const range = start.startContainer.ownerDocument.createRange();
              range.setStart(start.startContainer, start.startOffset);
              range.setEnd(end.endContainer, end.endOffset);
              activity.current?.page(loc.start.cfi, range.toString());
            }
          } catch {}
        })();
        const title = chapterForLocation(loc, chapters, (ePub as any).CFI) || "Reading";
        chapterRef.current = title;
        setChapter(title);
        const p = created.locations.length()
          ? created.locations.percentageFromCfi(loc.start.cfi)
          : Math.min(
              0.99,
              ((loc.start.index || 0) +
                (loc.start.displayed?.page || 0) / Math.max(1, loc.start.displayed?.total || 1)) /
                Math.max(1, created.spine.length),
            );
        if(initialAnchor.current){if(!anchorPage.current)anchorPage.current=loc.start.cfi;else if(anchorPage.current!==loc.start.cfi)initialAnchor.current="";}
        position.current = {
          cfi: initialAnchor.current||loc.start.cfi,
          progress: Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0,
        };
        setPercent(Math.round(position.current.progress * 100));
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => persistPosition(), 1200);
      });
      r.on("markClicked", (cfi: string, mark: any) => {
        const a = annotationRef.current.find((x) => x.cfi === cfi && x.bookId === id);
        if (a) {
          setActiveAnnotation(a);
          setSelection(null);
        }
      });
      r.on("displayError", (e: any) => {
        if (!canceled)
          setError("This chapter could not be displayed. Try another chapter from the contents.");
      });
      let cfi = new URLSearchParams(window.location.search).get("cfi") || (!previewMode?accountRef.current.library.find((x) => x.bookId === id)?.cfi:undefined);
      if(previewMode&&accountRef.current.user&&bookQuery.data?.productId&&!params.has("cfi"))try{const ps=await api(`/preview/state?productId=${encodeURIComponent(bookQuery.data.productId)}`);previewVersion.current=Number(ps?.version||0);if(ps?.cfi)cfi=ps.cfi;}catch{}
      const saved=sync.current?.current;if(!previewMode&&saved&&saved.epub_sha256===epubHash.current&&!params.has('cfi'))cfi=saved.cfi;
      if(!previewMode&&params.get('audioEdition'))try{const e=await loadEdition(params.get('audioEdition')!);const m=await resolveAudio(e,params.get('track')||'',Number(params.get('at')||0));if(e.bookId===id&&e.epubSha256===epubHash.current&&m){cfi=m.word.cfi;await sync.current?.save(e,m,'text');toast.message('Biosync: resumed at your spoken passage');}else toast.message('No checked match here. Opened your saved text position.');}catch(error){toast.message((error as Error).message);}
      initialAnchor.current=cfi||'';anchorPage.current='';
      try {
        await r.display(cfi || undefined);
      } catch {
        await r.display();
        toast.message("The previous location was unavailable. Opened the beginning instead.");
      }
      if (canceled) return;
      setReady(true);
      for (const a of annotationRef.current.filter((a) => a.bookId === id))
        try {
          r.annotations.highlight(a.cfi, { id: a.id }, undefined, "fore-highlight", {
            fill: colors[a.color],
            "fill-opacity": "0.35",
            "mix-blend-mode": settings.current.theme === "night" ? "screen" : "multiply",
          });
        } catch {}
      resize = new ResizeObserver(() => {
        if (container.current && rendition.current) {
          const { width, height } = container.current.getBoundingClientRect();
          if (width > 0 && height > 0) r.resize(width, height);
        }
      });
      resize.observe(container.current!);
      // Generate CFI progress locations once, without blocking the first readable chapter.
      created.locations
        .generate(1800)
        .then(() => {
          if (!canceled && position.current.cfi) {
            const p = created.locations.percentageFromCfi(position.current.cfi);
            if (Number.isFinite(p)) {
              position.current.progress = p;
              setPercent(Math.round(p * 100));
            }
          }
        })
        .catch(() => {});
    })().catch((e) => {
      if (!canceled) {
        console.error("EPUB load", e);
        setError(e.message || "This EPUB could not be opened.");
      }
    });
    function keys(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Tab" && !chromeVisibleRef.current) showChrome(false);
      if (e.key === "ArrowRight") {
        e.preventDefault();
        (formatRef.current.rtl?rendition.current?.prev():rendition.current?.next())?.catch?.(() => {});
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        (formatRef.current.rtl?rendition.current?.next():rendition.current?.prev())?.catch?.(() => {});
      }
      if (e.key === "Escape") {
        setSelection(null);
        hideChrome();
      }
    }
    document.addEventListener("keydown", keys);
    const visibility = () => {
      if (document.visibilityState === "hidden") persistPosition();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      canceled = true;
      mounted.current = false;
      activity.current?.stop();
      activity.current = null;
      resize?.disconnect();
      document.removeEventListener("keydown", keys);
      document.removeEventListener("visibilitychange", visibility);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      cancelChromeHide();
      persistPosition();
      rendition.current = null;
      created?.destroy();
    };
  }, [id, accountLoading, !!bookQuery.data, retry]);
  useEffect(() => {
    if (rendition.current && !formatRef.current.fixedLayout) applySettings(rendition.current);
    try {
      localStorage.setItem(
        "fore:epub-preferences",
        JSON.stringify({ fontSize, lineHeight, font, theme, flow }),
      );
    } catch {}
  }, [fontSize, lineHeight, font, theme, flow]);
  useEffect(()=>{
    if(!data.user||!settingSyncReady.current)return;
    const userId=data.user.id, values:Record<string,unknown>={
      "reader.fontSize":fontSize,"reader.lineHeight":lineHeight,"reader.font":font,"reader.theme":theme,"reader.flow":flow,
    };
    if(settingSaveTimer.current)clearTimeout(settingSaveTimer.current);
    settingSaveTimer.current=setTimeout(async()=>{
      for(const [key,value] of Object.entries(values)){
        if(Object.is(lastSyncedSettings.current[key],value))continue;
        try{
          const saved=await saveSyncedReaderSetting(userId,key,value,settingVersions.current[key]||0);
          settingVersions.current[key]=saved.version;lastSyncedSettings.current[key]=value;
        }catch(e){
          if((e as any)?.status===409){
            toast.message("A reader setting changed on another device. Cove kept both versions for review and refreshed the server value.");
            try{const remote=await loadSyncedReaderSettings(userId),entry=remote.settings[key];if(entry){settingVersions.current[key]=entry.version;lastSyncedSettings.current[key]=entry.value;if(key==="reader.fontSize")setFontSize(entry.value);else if(key==="reader.lineHeight")setLineHeight(entry.value);else if(key==="reader.font")setFont(entry.value);else if(key==="reader.theme")setTheme(entry.value);else if(key==="reader.flow")setFlow(entry.value);}}catch{}
          }
        }
      }
    },500);
    return()=>{if(settingSaveTimer.current)clearTimeout(settingSaveTimer.current);};
  },[data.user?.id,fontSize,lineHeight,font,theme,flow]);
  useEffect(() => {
    if (rendition.current && !formatRef.current.fixedLayout) rendition.current.flow(flow);
  }, [flow]);
  useEffect(() => {
    if (!ready || !rendition.current) return;
    const r = rendition.current;
    for (const a of data.annotations.filter((a) => a.bookId === id))
      try {
        r.annotations.remove(a.cfi, "highlight");
        r.annotations.highlight(a.cfi, { id: a.id }, undefined, "fore-highlight", {
          fill: colors[a.color],
          "fill-opacity": "0.35",
          "mix-blend-mode": "multiply",
        });
      } catch {}
  }, [data.annotations, ready, id]);
  async function saveHighlight(withNote = false) {
    if (!data.user) return signIn();
    if (!selection) return;
    setSaving(true);
    try {
      await api("/annotations", "POST", {
        bookId: id,
        quote: selection.text,
        cfi: selection.cfi,
        chapter: selection.chapter,
        color,
        note: withNote ? note : "",
        progress: position.current.progress,
      });
      await reload();
      toast.success(withNote ? "Highlight and note saved" : "Passage highlighted");
      setSelection(null);
      setNoteOpen(false);
      setNote("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function publishSocialDiscussion(){
    if(!data.user)return signIn();if(!selection||!socialBody.trim())return;
    setSocialBusy(true);try{
      const prefs=socialReader.data?.preferences,mode=prefs?.audienceMode||"friends";
      const visibility=mode==="group"?"group":mode==="public"?"public":mode==="friends"?"friends":"followers";
      await api("/social/posts","POST",{contextType:"margin",contextId:id,bookId:id,cfi:selection.cfi,chapter:selection.chapter,progress:position.current.progress,passageText:selection.text,body:socialBody,visibility,spoiler:false});
      setSocialBody("");setSocialCompose(null);setSelection(null);await socialReader.refetch();toast.success("Margin discussion posted");
    }catch(e){toast.error((e as Error).message);}finally{setSocialBusy(false);}
  }
  async function shareSelectedHighlight(){
    if(!data.user)return signIn();if(!selection)return;
    setSocialBusy(true);try{
      let annotationId=socialAnnotationId;
      if(!annotationId){const saved=await api<any>("/annotations","POST",{bookId:id,quote:selection.text,cfi:selection.cfi,chapter:selection.chapter,color,note:"",progress:position.current.progress});annotationId=saved.id;}
      const groupId=socialVisibility==="group"?socialReader.data?.preferences?.groupId:null;
      await api(`/social/highlights/${encodeURIComponent(annotationId!)}/share`,"POST",{visibility:socialVisibility,groupId,shareNote:!!socialAnnotationId&&socialShareNote,progress:position.current.progress});
      await reload();await socialReader.refetch();setSocialCompose(null);setSelection(null);setSocialAnnotationId(null);setSocialShareNote(false);toast.success("Highlight shared");
    }catch(e){toast.error((e as Error).message);}finally{setSocialBusy(false);}
  }
  async function saveSocialPreferences(next:any){
    if(!data.user)return signIn();const p=socialReader.data?.preferences||{enabled:false,audienceMode:"friends",groupId:null,showDiscussions:true,showHighlights:true,showReactions:false,density:35,version:0};
    try{await api("/social/reader/preferences","POST",{enabled:p.enabled,audienceMode:p.audienceMode,groupId:p.groupId,showDiscussions:p.showDiscussions,showHighlights:p.showHighlights,showReactions:p.showReactions,density:p.density,expectedVersion:p.version,...next});await socialReader.refetch();}catch(e){toast.error((e as Error).message);}
  }
  async function toggleBookmark(bookmark?:TextBookmark){
    if(!data.user)return signIn();
    if(previewMode){toast.message("Text bookmarks are available for full editions. Sample position is saved separately.");return;}
    const productId=bookQuery.data?.productId,cfi=position.current.cfi;if(!productId||!cfi)return;
    try{
      const client=await ensureSyncClient(data.user.id);
      if(bookmark) await api("/bookmarks/"+encodeURIComponent(bookmark.id),"DELETE",{expectedVersion:bookmark.version,clientId:client.clientId});
      else await api("/bookmarks","POST",{productId,externalBookId:id,cfi,chapter:chapter||"",label:chapter||`Bookmark at ${percent}%`,excerpt:"",progress:position.current.progress,clientId:client.clientId});
      await reload();toast.success(bookmark?"Bookmark removed":"Page bookmarked");
    }catch(e){toast.error((e as Error).message);}
  }
  async function searchBook() {
    if (!epub.current || !query.trim() || searching) return;
    setSearching(true);
    setMatches([]);
    try {
      const found: any[] = [];
      for (const item of epub.current.spine.spineItems) {
        await item.load(epub.current.load.bind(epub.current));
        found.push(...item.find(query.trim()));
        item.unload();
        if (found.length >= 100) break;
      }
      setMatches(found.slice(0, 100));
      if (!found.length) toast.message("No matches in this book.");
    } catch {
      toast.error("Search could not be completed. Please try again.");
    } finally {
      setSearching(false);
    }
  }
  async function go(href: string) {
    try {
      await rendition.current?.display(href);
      setPanel("");
      hideChrome();
    } catch {
      toast.error("This location could not be opened.");
    }
  }
  return (
    <div
      className={"reader-app theme-" + theme + (chromeVisible ? " chrome-visible" : "")}
      style={{ background: themes[theme].bg }}
      onPointerMove={(event)=>{if(event.clientY<=18||event.clientY>=window.innerHeight-18)showChrome();}}
    >
      <header
        className={"reader-top reader-chrome" + (chromeVisible ? " is-visible" : "")}
        onPointerEnter={()=>showChrome(false)}
        onPointerLeave={()=>scheduleChromeHide(1800)}
        onFocusCapture={()=>showChrome(false)}
        onBlurCapture={()=>scheduleChromeHide(1800)}
      >
        <a href={"/book/" + id} className="icon-button" aria-label="Leave reader">
          <ArrowLeft size={20} />
        </a>
        <div className="reader-book-title">
          <strong>{bookQuery.data?.title || "Opening book"}</strong>
          <span>{previewMode ? `SAMPLE · ${chapter || "EPUB READER"}` : (chapter || "EPUB READER")}</span>
        </div>
        <div className="reader-toolbar">
          {!previewMode && (!!editions.data?.results.length||!!syncEdition.current) && (
            <button
              className="icon-button"
              aria-label="Switch to audiobook"
              onClick={async () => {
                const edition = syncEdition.current||
                  editions.data!.results.find(
                    (e) => e.alignment?.verified && e.epubSha256 === epubHash.current,
                  ) || editions.data!.results[0];
                await persistPosition();
                if(syncConflict.current){toast.error("Biosync moved on another device. Reload before switching.");return;}
                await activity.current?.save();
                location.assign(
                  "/listen/" +
                    edition.id +
                    "?" +
                    new URLSearchParams({
                      fromText: "1",
                      cfi: position.current.cfi,
                      hash: epubHash.current,
                    }),
                );
              }}
            >
              <Headphones size={20} />
            </button>
          )}
          <button
            className="icon-button"
            title="Table of contents"
            aria-label="Table of contents"
            onClick={() => setPanel("contents")}
          >
            <List size={20} />
          </button>
          <button
            className="icon-button"
            title="Search this book"
            aria-label="Search this book"
            onClick={() => setPanel("search")}
          >
            <Search size={19} />
          </button>
          {!previewMode && <button
            className="icon-button"
            title="Text bookmarks"
            aria-label="Text bookmarks"
            onClick={() => setPanel("bookmarks")}
          >
            <Bookmark size={19} />
          </button>}
          <button
            className="icon-button"
            title="Book highlights"
            aria-label="Book highlights"
            onClick={() => setPanel("highlights")}
          >
            <Highlighter size={19} />
          </button>
          {!previewMode && <button
            className={`icon-button ${socialReader.data?.preferences?.enabled?"social-active":""}`}
            title="Social Reading"
            aria-label="Social Reading"
            onClick={() => setPanel("social")}
          >
            <Users size={19} />
          </button>}
          <button
            className="icon-button"
            title="Reading settings"
            aria-label="Reading settings"
            onClick={() => setPanel("settings")}
          >
            <Settings2 size={20} />
          </button>
        </div>
      </header>
      <div className="reader-stage" style={{ background: themes[theme].bg }}>
        <button
          aria-label="Previous page"
          className="reader-page-turn prev"
          disabled={!ready}
          onClick={() => rendition.current?.prev().catch(() => {})}
        >
          <ChevronLeft size={26} />
        </button>
        <div ref={container} className="epub-container" style={{ background: themes[theme].bg }} />
        {!ready && !error && (
          <div className="reader-loading">
            <BookOpen size={34} />
            <h2>Opening a new chapter.</h2>
            <p>Preparing the book and its original styles…</p>
            <Loader2 className="spin" size={20} />
          </div>
        )}
        {(error || bookQuery.error) && (
          <div className="reader-loading">
            <h2>This book needs a moment.</h2>
            <p>{error || bookQuery.error?.message}</p>
            <button
              className="button gold"
              onClick={() => {
                bookQuery.refetch();
                setRetry((n) => n + 1);
              }}
            >
              Try again
            </button>
            <a className="text-link" href={"/book/" + id}>
              Back to book details
            </a>
          </div>
        )}
        {!!socialReader.data?.preferences?.enabled && !!socialReader.data?.indicators?.length && <aside className="reader-social-gutter" aria-label="Social reading indicators">
          {socialReader.data.indicators.map((indicator:any)=><button key={indicator.passageHash} onClick={()=>{setActiveSocial(indicator);setPanel("social");}} title={`${indicator.discussionCount||0} discussions · ${indicator.highlightCount||0} shared highlights`}><span>•</span><small>{(indicator.discussionCount||0)+(indicator.highlightCount||0)}</small></button>)}
        </aside>}
        <button
          aria-label="Next page"
          className="reader-page-turn next"
          disabled={!ready}
          onClick={() => rendition.current?.next().catch(() => {})}
        >
          <ChevronRight size={26} />
        </button>
      </div>
      <footer
        className={"reader-bottom reader-chrome" + (chromeVisible ? " is-visible" : "")}
        onPointerEnter={()=>showChrome(false)}
        onPointerLeave={()=>scheduleChromeHide(1800)}
        onFocusCapture={()=>showChrome(false)}
        onBlurCapture={()=>scheduleChromeHide(1800)}
      >
        <span>{ready ? chapter : "Preparing book…"}</span>
        <div>
          <span>{ready ? percent + (previewMode ? "% of sample" : "% read") : ""}</span>
          {data.user ? (
            <button className="reader-save-status" onClick={persistPosition}>
              {saveState || (previewMode ? "Your sample place will be saved" : "Your place will be saved")}
            </button>
          ) : (
            <button onClick={signIn} className="text-link">
              Sign in to save your place
            </button>
          )}
        </div>
      </footer>
      {selection && !noteOpen && !dictionary && (
        <div className="selection-toolbar">
          <span className="selection-preview">
            “{selection.text.slice(0, 75)}
            {selection.text.length > 75 ? "…" : ""}”
          </span>
          <div className="selection-actions">
            <div className="color-options">
              {Object.entries(colors).map(([c, v]) => (
                <button
                  key={c}
                  className={"color-dot " + (color === c ? "selected" : "")}
                  style={{ background: v }}
                  aria-label={c + " highlight"}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <button onClick={() => saveHighlight()} disabled={saving}>
              <Highlighter size={17} />
              Highlight
            </button>
            <button
              onClick={() => {
                if (!data.user) return signIn();
                setNoteOpen(true);
              }}
            >
              <Pencil size={17} />
              Note
            </button>
            {!previewMode && <button onClick={()=>{setSocialCompose("discussion");setSocialBody("");}} title="Start a margin discussion"><MessageCircle size={17}/> Discuss</button>}
            {!previewMode && <button onClick={()=>{const p=socialReader.data?.preferences;setSocialVisibility(p?.audienceMode==="public"?"public":p?.audienceMode==="group"?"group":p?.audienceMode==="following"?"followers":"friends");setSocialAnnotationId(null);setSocialShareNote(false);setSocialCompose("share");}} title="Share this highlight"><Share2 size={17}/> Share</button>}
            <button onClick={() => setDictionary(selection)}>
              <BookA size={17} />
              Define
            </button>
            <button aria-label="Dismiss selection" onClick={() => setSelection(null)}>
              <X size={17} />
            </button>
          </div>
        </div>
      )}
      {activeAnnotation && (
        <div className="annotation-popover">
          <button
            className="icon-button"
            aria-label="Close saved note"
            onClick={() => setActiveAnnotation(null)}
          >
            <X size={16} />
          </button>
          <strong>Saved passage</strong>
          <p>{activeAnnotation.note || activeAnnotation.quote}</p>
          <div className="annotation-social-actions"><a className="text-link" href="/highlights">Edit in your notebook <Pencil size={14} /></a>{!previewMode&&<button className="text-link" onClick={()=>{const p=socialReader.data?.preferences;setSelection({text:activeAnnotation.quote,cfi:activeAnnotation.cfi,chapter:activeAnnotation.chapter});setSocialVisibility(p?.audienceMode==="public"?"public":p?.audienceMode==="group"?"group":p?.audienceMode==="following"?"followers":"friends");setSocialAnnotationId(activeAnnotation.id);setSocialShareNote(false);setActiveAnnotation(null);setSocialCompose("share");}}><Share2 size={14}/> Share this saved highlight</button>}</div>
        </div>
      )}
      <Sheet
        open={!!panel}
        onOpenChange={(v) => {
          if (!v) {
            setPanel("");
            hideChrome();
          }
        }}
      >
        <SheetContent className="fore-reader-sheet" side="right">
          <SheetHeader>
            <SheetTitle>
              {panel === "contents"
                ? "Chapters"
                : panel === "search"
                  ? "Find in this book"
                  : panel === "highlights"
                    ? "Your saved passages"
                    : panel === "bookmarks"
                      ? "Your bookmarks"
                      : panel === "social"
                        ? "Social Reading"
                        : "Make yourself comfortable"}
            </SheetTitle>
            <SheetDescription>{bookQuery.data?.title}</SheetDescription>
          </SheetHeader>
          <div className="reader-panel-body">
            {panel === "contents" && (
              <nav className="toc-list">
                {toc.map((item, i) => (
                  <button key={item.id + i} onClick={() => go(item.href)}>
                    {item.label}
                  </button>
                ))}
              </nav>
            )}
            {panel === "search" && (
              <>
                <form
                  className="book-search-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    searchBook();
                  }}
                >
                  <input
                    aria-label="Search text in book"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search a word or phrase…"
                    maxLength={100}
                  />
                  <button className="button gold" disabled={searching || !ready}>
                    {searching ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
                  </button>
                </form>
                <p className="small muted">
                  {matches.length
                    ? `${matches.length}${matches.length === 100 ? "+" : ""} matches`
                    : ""}
                </p>
                <div className="book-search-results">
                  {matches.map((m, i) => (
                    <button key={i} onClick={() => go(m.cfi)}>
                      {m.excerpt}
                    </button>
                  ))}
                </div>
              </>
            )}
            {panel === "bookmarks" && (
              <div className="reader-highlights">
                <button className="button gold" onClick={()=>{const exact=data.bookmarks.find((b)=>b.bookId===id&&b.cfi===position.current.cfi);toggleBookmark(exact);}}>
                  <Bookmark size={16}/> {data.bookmarks.some((b)=>b.bookId===id&&b.cfi===position.current.cfi)?"Remove bookmark here":"Bookmark current page"}
                </button>
                {data.bookmarks.filter((b)=>b.bookId===id).length ? data.bookmarks.filter((b)=>b.bookId===id).map((b)=>(
                  <button key={b.id} onClick={()=>go(b.cfi)}>
                    <strong>{b.label||b.chapter||`Bookmark at ${Math.round(b.progress*100)}%`}</strong>
                    <p className="small muted">{b.chapter||`${Math.round(b.progress*100)}% read`}</p>
                  </button>
                )) : <p className="muted small">Bookmarks mark a reading location without highlighting text. Add one for any page you want to return to.</p>}
              </div>
            )}
            {panel === "highlights" && (
              <div className="reader-highlights">
                {data.annotations.filter((a) => a.bookId === id).length ? (
                  data.annotations
                    .filter((a) => a.bookId === id)
                    .map((a) => (
                      <button
                        onClick={() => go(a.cfi)}
                        key={a.id}
                        style={{ borderLeftColor: colors[a.color] }}
                      >
                        <blockquote>{a.quote}</blockquote>
                        {a.note && <p>{a.note}</p>}
                      </button>
                    ))
                ) : (
                  <p className="muted small">
                    Select a passage in the book, then choose Highlight or Note. Your saved passages
                    will appear here.
                  </p>
                )}
              </div>
            )}
            {panel === "social" && <div className="reader-social-panel">
              {!data.user?<div className="empty-state"><Users size={30}/><h3>Read alongside people you choose.</h3><p>Sign in to enable spoiler-aware shared highlights and margin conversations.</p><button className="button gold" onClick={signIn}>Sign in</button></div>:<>
                <div className="social-reading-toggle"><div><strong>Social Reading</strong><p className="small muted">Off by default. The book stays clean until you ask for this layer.</p></div><input aria-label="Enable Social Reading" type="checkbox" checked={!!socialReader.data?.preferences?.enabled} onChange={e=>saveSocialPreferences({enabled:e.target.checked})}/></div>
                <label>Whose activity</label><Select value={socialReader.data?.preferences?.audienceMode||"friends"} onValueChange={v=>saveSocialPreferences({audienceMode:v,groupId:v==="group"?(socialReader.data?.preferences?.groupId||socialAccount.data?.groups?.find((g:any)=>g.member_status==="active")?.id||null):null})}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="friends">Friends / mutuals</SelectItem><SelectItem value="following">People I follow</SelectItem><SelectItem value="group">Reading group</SelectItem><SelectItem value="public">Public readers</SelectItem></SelectContent></Select>
                {socialReader.data?.preferences?.audienceMode==="group"&&<><label>Reading group</label><Select value={socialReader.data?.preferences?.groupId||""} onValueChange={v=>saveSocialPreferences({groupId:v})}><SelectTrigger><SelectValue placeholder="Choose a group"/></SelectTrigger><SelectContent>{socialAccount.data?.groups?.filter((g:any)=>g.member_status==="active").map((g:any)=><SelectItem value={g.id} key={g.id}>{g.name}</SelectItem>)}</SelectContent></Select></>}
                <div className="social-show-options"><label><input type="checkbox" checked={!!socialReader.data?.preferences?.showDiscussions} onChange={e=>saveSocialPreferences({showDiscussions:e.target.checked})}/> Discussions</label><label><input type="checkbox" checked={!!socialReader.data?.preferences?.showHighlights} onChange={e=>saveSocialPreferences({showHighlights:e.target.checked})}/> Shared highlights</label><label><input type="checkbox" checked={!!socialReader.data?.preferences?.showReactions} onChange={e=>saveSocialPreferences({showReactions:e.target.checked})}/> Reactions</label></div>
                <label>Density <span>{Number(socialReader.data?.preferences?.density||35)<20?"Quiet":Number(socialReader.data?.preferences?.density||35)<67?"Balanced":"Lively"}</span></label><Slider key={socialReader.data?.preferences?.version||0} min={0} max={100} step={1} defaultValue={[Number(socialReader.data?.preferences?.density||35)]} onValueCommit={v=>saveSocialPreferences({density:v[0]})}/>
                <p className="small muted">🔒 Conversations ahead of your verified ebook/audiobook/Biosync progress stay locked. At most three indicators are shown on a screen.</p>
                {activeSocial&&<section className="margin-conversation-card"><button className="text-link" onClick={()=>setActiveSocial(null)}>← All visible activity</button><h3>{activeSocial.discussionCount||0} discussions · {activeSocial.highlightCount||0} highlights</h3>{activeSocial.posts?.map((p:any)=><article key={p.id}><strong>{p.user?.name||"Reader"}</strong>{p.passageText&&<blockquote>“{p.passageText}”</blockquote>}<p>{p.body}</p><small>{p.chapter}</small></article>)}{activeSocial.highlights?.map((h:any)=><article key={h.id}><strong>{h.name||"Reader"} highlighted</strong><blockquote>“{h.quote}”</blockquote>{h.note&&<p>{h.note}</p>}</article>)}</section>}
                {!activeSocial&&<div className="reader-social-summary"><strong>{socialReader.data?.totalVisible||0} relevant conversations/highlight clusters reached so far</strong><p className="small muted">Only the strongest {socialReader.data?.indicators?.length||0} are marked in the margin right now.</p>{socialReader.data?.indicators?.map((x:any)=><button key={x.passageHash} onClick={()=>setActiveSocial(x)}><span>• {(x.discussionCount||0)+(x.highlightCount||0)}</span><strong>{x.chapter||"This passage"}</strong><small>{x.discussionCount||0} discussions · {x.highlightCount||0} highlights</small></button>)}</div>}
              </>}
            </div>}
            {panel === "settings" && (
              <div className="reading-settings">
                {formatInfo.fixedLayout&&<div className="reader-format-notice" role="status"><strong>Fixed-layout edition</strong><p className="small muted">The publisher controls page geometry and typography for this edition, so text size, line spacing, typeface, and scrolling overrides are unavailable.</p></div>}
                {formatInfo.verticalWriting&&<p className="small muted" role="status">Vertical writing is preserved from the publisher EPUB. Keyboard page direction follows the book’s declared reading order.</p>}
                <label>Page color</label>
                <div className="theme-options">
                  {Object.entries(themes).map(([key, t]) => (
                    <button
                      key={key}
                      aria-label={key + " reading theme"}
                      className={theme === key ? "selected" : ""}
                      style={{ background: t.bg, color: t.fg }}
                      onClick={() => setTheme(key as keyof typeof themes)}
                    >
                      Aa<span>{key}</span>
                    </button>
                  ))}
                </div>
                <label>
                  Text size <span>{fontSize}px</span>
                </label>
                <Slider
                  aria-label="Text size"
                  min={14}
                  max={32}
                  step={1}
                  value={[fontSize]}
                  disabled={formatInfo.fixedLayout}
                  onValueChange={(v) => setFontSize(v[0])}
                />
                <label>
                  Line spacing <span>{lineHeight.toFixed(2)}</span>
                </label>
                <Slider
                  aria-label="Line spacing"
                  min={1.2}
                  max={2.2}
                  step={0.05}
                  value={[lineHeight]}
                  disabled={formatInfo.fixedLayout}
                  onValueChange={(v) => setLineHeight(v[0])}
                />
                <label>Typeface</label>
                <Select value={font} onValueChange={setFont}>
                  <SelectTrigger aria-label="Reader typeface" disabled={formatInfo.fixedLayout}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="publisher">Publisher’s typeface</SelectItem>
                    <SelectItem value="serif">Classic serif</SelectItem>
                    <SelectItem value="sans-serif">Clean sans serif</SelectItem>
                  </SelectContent>
                </Select>
                <label>Reading flow</label>
                <Select value={flow} onValueChange={setFlow}>
                  <SelectTrigger aria-label="Reading flow" disabled={formatInfo.fixedLayout}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="paginated">Turn pages</SelectItem>
                    <SelectItem value="scrolled-doc">Scroll chapters</SelectItem>
                  </SelectContent>
                </Select>
                <p className="small muted">
                  Your reading appearance syncs across your signed-in devices with per-setting conflict protection. Original book styling is kept where compatible with your choices.
                </p>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <Dialog open={!!finishedJourney} onOpenChange={v=>{if(!v)setFinishedJourney(null)}}><DialogContent className="fore-dialog finish-journey-dialog"><DialogTitle>Finished.</DialogTitle><DialogDescription>{bookQuery.data?.title}</DialogDescription><div className="finish-mark"><Check size={30}/><strong>{percent}%</strong></div><p>Your Reading Journey is ready—a private-by-default record of how this book fit into your life, including your reading/listening mix, sessions, highlights, notes, and timeline.</p><div className="journey-share-row"><a className="button gold" href={`/community?journey=${encodeURIComponent(finishedJourney||"")}`}>View Reading Journey</a><button className="button outline" onClick={()=>setFinishedJourney(null)}>Stay in the book</button></div></DialogContent></Dialog>
      <Dialog open={socialCompose==="discussion"} onOpenChange={v=>{if(!v)setSocialCompose(null)}}><DialogContent className="fore-dialog social-compose-dialog"><DialogTitle>Start a margin conversation.</DialogTitle><DialogDescription>This discussion is attached to the passage and spoiler-gated by reading progress.</DialogDescription><blockquote className="editor-quote">{selection?.text}</blockquote><textarea className="note-input" value={socialBody} onChange={e=>setSocialBody(e.target.value)} maxLength={12000} placeholder="What do you want other readers to notice?"/><button className="button gold" disabled={socialBusy||!socialBody.trim()} onClick={publishSocialDiscussion}>{socialBusy?"Posting…":"Post discussion"}</button></DialogContent></Dialog>
      <Dialog open={socialCompose==="share"} onOpenChange={v=>{if(!v){setSocialCompose(null);setSocialAnnotationId(null);setSocialShareNote(false);}}}><DialogContent className="fore-dialog social-compose-dialog"><DialogTitle>Share this highlight.</DialogTitle><DialogDescription>Your saved notes remain private unless you explicitly choose to share them.</DialogDescription><blockquote className="editor-quote">{selection?.text}</blockquote><label>Audience<Select value={socialVisibility} onValueChange={(v:any)=>setSocialVisibility(v)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="friends">Friends / mutuals</SelectItem><SelectItem value="followers">Followers</SelectItem><SelectItem value="group">Selected reading group</SelectItem><SelectItem value="public">Public</SelectItem></SelectContent></Select></label>{socialAnnotationId&&data.annotations.find((a)=>a.id===socialAnnotationId)?.note&&<label className="check-row"><input type="checkbox" checked={socialShareNote} onChange={e=>setSocialShareNote(e.target.checked)}/> Include my private note with this shared highlight</label>}<p className="small muted">Private is still the default for normal highlights. This action explicitly publishes this one.</p><button className="button gold" disabled={socialBusy||(socialVisibility==="group"&&!socialReader.data?.preferences?.groupId)} onClick={shareSelectedHighlight}>{socialBusy?"Sharing…":"Share highlight"}</button></DialogContent></Dialog>
      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent className="fore-dialog">
          <DialogTitle>A thought in the margin.</DialogTitle>
          <DialogDescription>Add a note to this exact passage.</DialogDescription>
          <blockquote className="editor-quote">{selection?.text}</blockquote>
          <textarea
            className="note-input"
            aria-label="Passage note"
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={12000}
            placeholder="What are you thinking?"
          />
          <button className="button gold" disabled={saving} onClick={() => saveHighlight(true)}>
            {saving ? "Saving…" : "Save note & highlight"}
          </button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!dictionary}
        onOpenChange={(v) => {
          if (!v) setDictionary(null);
        }}
      >
        <DialogContent className="fore-dialog dictionary-dialog">
          <DialogTitle>A word, understood.</DialogTitle>
          <DialogDescription>{dictionary?.text.slice(0, 120)}</DialogDescription>
          {dictionary && (
            <DictionaryLookup
              key={dictionary.cfi}
              initialWord={dictionary.text
                .trim()
                .split(/\s+/)[0]
                .replace(/[^a-zA-Z'-]/g, "")}
              bookId={id}
              bookTitle={bookQuery.data?.title}
              cfi={dictionary.cfi}
              context={dictionary.text}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
