import { getRecord, putRecord, sha256 } from "./offline";
import JSZip from "jszip";
import { api, downloadBlob, authorOf, type CatalogBook } from "./client";
export async function inspectEpub(bytes: ArrayBuffer | Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files);
  if (
    files.length > 3000 ||
    files.reduce((n, f) => n + ((f as any)._data?.uncompressedSize || 0), 0) > 60 * 1024 * 1024
  )
    throw Error("This EPUB expands beyond the 60 MB reading limit.");
  if ((await zip.file("mimetype")?.async("string")) !== "application/epub+zip")
    throw Error("Choose a valid EPUB file.");
  if (zip.file("META-INF/encryption.xml"))
    throw Error("Encrypted EPUBs are not supported. Choose a DRM-free edition.");
  const xml = await zip.file("META-INF/container.xml")?.async("string");
  if (!xml) throw Error("The EPUB container is missing.");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const path = doc.getElementsByTagName("rootfile")[0]?.getAttribute("full-path");
  if (!path || !zip.file(path)) throw Error("The EPUB package is missing.");
  const opf = new DOMParser().parseFromString(
    await zip.file(path)!.async("string"),
    "application/xml",
  );
  const field = (name: string) => opf.getElementsByTagNameNS("*", name)[0]?.textContent || "";
  const meta = (property: string) => opf.querySelector(`meta[property="${property}"]`)?.textContent?.trim() || "";
  const packageVersion=opf.documentElement.getAttribute("version")||"";
  const layout=meta("rendition:layout")||"reflowable";
  const spine=opf.getElementsByTagNameNS("*","spine")[0];
  const pageProgressionDirection=spine?.getAttribute("page-progression-direction")||"default";
  const hasNav=Array.from(opf.getElementsByTagNameNS("*","item")).some((item)=>String(item.getAttribute("properties")||"").split(/\s+/).includes("nav"));
  const hasNcx=Array.from(opf.getElementsByTagNameNS("*","item")).some((item)=>item.getAttribute("media-type")==="application/x-dtbncx+xml");
  let cssText="";
  for(const file of files.filter((f)=>/\.css$/i.test(f.name)&&!f.dir).slice(0,100)){if(cssText.length>300000)break;cssText+=(await file.async("string")).slice(0,50000);}
  const writingMode=meta("primary-writing-mode")||(/writing-mode\s*:\s*(vertical-rl|vertical-lr|tb-rl|tb-lr)/i.exec(cssText)?.[1]||"horizontal-tb");
  const rtl=pageProgressionDirection==="rtl"||/direction\s*:\s*rtl/i.test(cssText);
  return {
    zip,
    title: field("title") || "Untitled book",
    author: field("creator") || "Unknown author",
    language: field("language") || "en",
    packageVersion,
    epubVersion: packageVersion.startsWith("2") ? "EPUB 2" : packageVersion.startsWith("3") ? "EPUB 3" : "EPUB",
    layout,
    fixedLayout: layout === "pre-paginated",
    pageProgressionDirection,
    rtl,
    writingMode,
    verticalWriting: /^vertical|^tb-/i.test(writingMode),
    navigationType: hasNav && hasNcx ? "both" : hasNav ? "epub3_nav" : hasNcx ? "ncx" : "unknown",
  };
}
export async function prepareEpub(bytes: ArrayBuffer) {
  const info = await inspectEpub(bytes);
  const sanitizeCss=(value:string)=>value
    .replace(/@import\s+(?:url\()?\s*(["']?)(?:https?:)?\/\/[^;]+;/gi, "/* remote import removed by Cove */")
    .replace(/url\(\s*(["']?)(?:https?:)?\/\/[^)]*\)/gi, 'url("")');
  for(const entry of Object.values(info.zip.files)){
    if(entry.dir||!/\.css$/i.test(entry.name))continue;
    const css=await entry.async("string");
    info.zip.file(entry.name,sanitizeCss(css));
  }
  for (const entry of Object.values(info.zip.files)) {
    if (entry.dir || !/\.(xhtml|html|htm|svg)$/i.test(entry.name)) continue;
    const xml = await entry.async("string");
    const doc = new DOMParser().parseFromString(xml, "application/xhtml+xml");
    if (doc.querySelector("parsererror"))
      throw Error("A chapter in this EPUB contains invalid XHTML.");
    doc
      .querySelectorAll("script,iframe,frame,object,embed,form,input,button,textarea,base")
      .forEach((n) => n.remove());
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      const tag=el.tagName.toLowerCase();
      for (const attr of Array.from(el.attributes)) {
        const name=attr.name.toLowerCase(),value=attr.value.trim();
        if (/^on/i.test(attr.name) || name === "srcdoc" || /^\s*(javascript|vbscript):/i.test(value)) {
          el.removeAttribute(attr.name);
          continue;
        }
        if(name==="style"){
          const clean=sanitizeCss(attr.value);
          if(clean!==attr.value)el.setAttribute(attr.name,clean);
        }
        if(["src","srcset","poster","data","href","xlink:href"].includes(name)&&/^(?:https?:)?\/\//i.test(value)&&tag!=="a")el.removeAttribute(attr.name);
      }
      if (tag === "meta" && el.getAttribute("http-equiv")) el.remove();
    }
    doc.querySelectorAll("style").forEach((node)=>{node.textContent=sanitizeCss(node.textContent||"");});
    const head = doc.getElementsByTagName("head")[0];
    if (head) {
      if (!info.fixedLayout) {
        const guard = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
        guard.setAttribute("data-fore-reader-guard", "true");
        guard.textContent = "img,svg,video{max-width:100%;height:auto} table{max-width:100%;overflow-wrap:anywhere} pre,code{white-space:pre-wrap;overflow-wrap:anywhere}";
        head.appendChild(guard);
      }
      const meta = doc.createElementNS("http://www.w3.org/1999/xhtml", "meta");
      meta.setAttribute("http-equiv", "Content-Security-Policy");
      meta.setAttribute(
        "content",
        "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob: data:; font-src blob: data:; media-src blob: data:; base-uri 'none'; form-action 'none';",
      );
      head.prepend(meta);
    }
    info.zip.file(entry.name, new XMLSerializer().serializeToString(doc));
  }
  return {
    bytes: await info.zip.generateAsync({ type: "arraybuffer", compression: "STORE" }),
    metadata: info,
  };
}
export async function epubBytes(bookId: string, preview = false, cacheScope = "") {
  // Public Gutenberg files may use a device-wide cache. Commercial offline files must be account-scoped
  // so signing into another Cove account on the same browser cannot bypass the server entitlement check.
  const publicCache = /^\d+$/.test(bookId); // legacy source-ID cache keys remain readable; new canonical IDs are account/source aware below.
  const cacheKey = publicCache ? `epub:${bookId}` : cacheScope ? `epub:${cacheScope}:${bookId}` : "";
  if (!preview && cacheKey) {
    const cached = await getRecord("assets", cacheKey).catch(() => null);
    if (cached) return (cached.blob as Blob).arrayBuffer();
  }
  const r = await fetch(`/api/fore/books/${encodeURIComponent(bookId)}/${preview ? "preview/epub" : "epub"}`);
  if (!r.ok) {
    const d = await r.json().catch(() => null);
    throw Error(d?.error || "This EPUB could not be downloaded.");
  }
  return r.arrayBuffer();
}
async function downloadableEpubBytes(bookId:string){
  const r=await fetch(`/api/fore/books/${encodeURIComponent(bookId)}/download/epub`,{credentials:"same-origin"});
  if(!r.ok){const d=await r.json().catch(()=>null);throw Error(d?.error||"This edition is not available as a downloadable EPUB.");}
  return r.arrayBuffer();
}
function safeDownloadName(title: string) {
  return title.normalize("NFKD").replace(/[^a-zA-Z0-9 -]/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "book";
}
async function sha256Hex(bytes:ArrayBuffer){
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(x=>x.toString(16).padStart(2,"0")).join("");
}

/** Licensed/public-domain content export. Deliberately contains no account or reading data. */
export async function downloadBook(book: CatalogBook) {
  const bytes=await downloadableEpubBytes(String(book.id));
  downloadBlob(new Blob([bytes],{type:"application/epub+zip"}),safeDownloadName(book.title)+".epub");
}

/** Personal-data export. Deliberately contains no copyrighted book payload. */
export async function exportReadingData(book:CatalogBook){
  const data=await api<any>(`/exports/reading-data/${encodeURIComponent(String(book.id))}`);
  const zip=new JSZip();
  zip.file("reading-data.json",JSON.stringify(data,null,2));
  zip.file("annotations.json",JSON.stringify(data.annotations||[],null,2));
  zip.file("definitions.json",JSON.stringify(data.definitions||[],null,2));
  zip.file("history.json",JSON.stringify({sessions:data.sessions||[],completionHistory:data.completionHistory||[],previewState:data.previewState||null,biosync:data.biosync||null},null,2));
  zip.file("README.txt",`FORE READING DATA EXPORT v2\n${book.title}\n\nPRIVATE DATA ONLY — NO EBOOK FILE IS INCLUDED.\n\nThis export can contain highlights, notes, saved vocabulary, reading positions, completion history, and reading-session history. Review these files before sharing them. It is intended for personal archival or migration of your reading data.\n`);
  downloadBlob(await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:6}}),safeDownloadName(book.title)+"-fore-reading-data.zip");
}

/** Explicit private backup. Combines the content entitlement export with personal reading data. */
export async function downloadCoveBackup(book:CatalogBook){
  const [bytes,reading]=await Promise.all([downloadableEpubBytes(String(book.id)),api<any>(`/exports/reading-data/${encodeURIComponent(String(book.id))}?purpose=private-backup`)]);
  const hash=await sha256Hex(bytes),zip=new JSZip(),id=String(book.id);
  zip.file("book/book.epub",bytes);
  zip.file("book/metadata.json",JSON.stringify(book,null,2));
  zip.file("personal/reading-data.json",JSON.stringify(reading,null,2));
  zip.file("personal/annotations.json",JSON.stringify(reading.annotations||[],null,2));
  zip.file("personal/definitions.json",JSON.stringify(reading.definitions||[],null,2));
  zip.file("personal/history.json",JSON.stringify({readingState:reading.readingState||null,sessions:reading.sessions||[],completionHistory:reading.completionHistory||[],previewState:reading.previewState||null,biosync:reading.biosync||null},null,2));
  const manifest={format:"fore-private-backup",version:2,createdAt:new Date().toISOString(),privacy:{classification:"private-reading-backup",containsBookContent:true,containsPersonalData:true,sharingWarning:"Do not share this package unless you intend to share your highlights, notes, vocabulary, and reading history."},book:{id,title:book.title,authors:book.authors,language:book.languages[0]||"en",file:"book/book.epub",bytes:bytes.byteLength,sha256:hash},source:book.uploaded?{type:"personal-import"}:book.sourceName==="gutenberg"||/^\d+$/.test(id)?{type:"public-domain-edition",project:book.sourceProject||"Project Gutenberg",sourceUrl:book.sourceUrl||null}:{type:"licensed-commercial-edition",publisher:book.publisher||null,redistribution:"May be restricted by the publisher license."},files:{metadata:"book/metadata.json",readingData:"personal/reading-data.json",annotations:"personal/annotations.json",definitions:"personal/definitions.json",history:"personal/history.json"},requirements:{epub:"EPUB 2/3",annotations:"EPUB CFI support",drm:book.drmStatus||"none"}};
  zip.file("manifest.json",JSON.stringify(manifest,null,2));
  zip.file("README-PRIVATE.txt",`FORE PRIVATE BACKUP v2\n${book.title}\n${authorOf(book)}\n\nWARNING: THIS ARCHIVE CONTAINS BOTH THE EBOOK AND YOUR PRIVATE READING DATA.\n\nThe personal/ directory may contain highlights, notes, dictionary words, reading positions, and reading-session history. Do not send or post this ZIP as if it were merely an ebook file. Use “Download book” when you only want the licensed/public-domain EPUB, or “Export reading data” when you only want your personal data.\n\nRights to redistribute book/book.epub depend on the edition and your territory/license.\n`);
  downloadBlob(await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:3}}),safeDownloadName(book.title)+"-fore-private-backup.zip");
}

export async function saveEpubOffline(book: CatalogBook, userId = "") {
  if (book.uploaded)
    throw Error("Personal imports already live in your private Cove library.");
  const id=String(book.id),isPublic=book.sourceName === "gutenberg" || /^\d+$/.test(id);
  if(!isPublic) throw Error("In-app offline storage for licensed editions requires Cove's future protected offline-license layer. Use the publisher-permitted EPUB download instead.");
  const bytes = await epubBytes(id,false,"");
  await inspectEpub(bytes);
  const key = `epub:${id}`;
  await navigator.storage?.persist?.();
  await putRecord("assets", { id: key, blob: new Blob([bytes], { type: "application/epub+zip" }) });
  await putRecord("downloads", {
    id: key,
    title: book.title,
    kind: "epub",
    book,
    bytes: bytes.byteLength,
    assetIds: [key],
    complete: true,
    updatedAt: new Date().toISOString(),
  });
}
export async function loadBookMetadata(id: string): Promise<CatalogBook> {
  try {
    return await api("/books/" + id);
  } catch (error) {
    const local = await getRecord("downloads", "epub:" + id);
    if (local?.book) return local.book;
    const meta=await getRecord("assets","book-meta:"+id).catch(()=>null);if(meta?.book)return meta.book;
    throw error;
  }
}
