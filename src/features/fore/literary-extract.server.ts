import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { validateStoredEpub } from "./stored-epub.server";

export const LITERARY_TEXT_LIMIT = 1_500_000;
export const LITERARY_SECTION_LIMIT = 256;
export type LiterarySection = {
  id: string;
  spineIndex: number;
  href: string;
  title: string;
  chunkIndex: number;
  charStart: number;
  charEnd: number;
  text: string;
};
/** Bounded archive extraction. Never evaluates scripts, loads resources or follows URLs. */
export async function extractLiterarySections(bytes: Uint8Array) {
  if (bytes.length > 16 * 1024 * 1024) throw new Error("EPUB exceeds profiling byte limit");
  await validateStoredEpub(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const parse = (text: string) => {
    if (/<!ENTITY\b/i.test(text)) throw new Error("XML entities are not profiling evidence");
    return new DOMParser().parseFromString(text, "application/xml");
  };
  const container = parse(await zip.file("META-INF/container.xml")!.async("string"));
  const opfPath = container.getElementsByTagNameNS("*", "rootfile")[0].getAttribute("full-path")!;
  const opf = parse(await zip.file(opfPath)!.async("string"));
  const manifest = new Map(
    Array.from(opf.getElementsByTagNameNS("*", "item")).map((n) => [n.getAttribute("id"), n]),
  );
  const spine = Array.from(opf.getElementsByTagNameNS("*", "itemref"));
  const sections: LiterarySection[] = [];
  let totalChars = 0,
    truncated = false;
  outer: for (let i = 0; i < spine.length; i++) {
    const ref = spine[i];
    const item = manifest.get(ref.getAttribute("idref"));
    if (
      !item ||
      ref.getAttribute("linear") === "no" ||
      /\bnav\b/.test(item.getAttribute("properties") || "")
    )
      continue;
    if (!["application/xhtml+xml", "text/html"].includes(item.getAttribute("media-type") || ""))
      continue;
    const href = decodeURIComponent(
      new URL(item.getAttribute("href")!, "https://epub.invalid/" + opfPath).pathname.slice(1),
    );
    const file = zip.file(href);
    if (!file) continue;
    const declared =
      (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0;
    if (declared > 4 * 1024 * 1024) {
      truncated = true;
      continue;
    }
    const doc = parse(await file.async("string"));
    for (const tag of ["script", "style", "nav", "head"]) {
      for (const node of Array.from(doc.getElementsByTagNameNS("*", tag)))
        node.parentNode?.removeChild(node);
    }
    const text = (doc.getElementsByTagNameNS("*", "body")[0]?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 250) continue;
    const title = (
      doc.getElementsByTagNameNS("*", "h1")[0]?.textContent ||
      doc.getElementsByTagNameNS("*", "h2")[0]?.textContent ||
      `Section ${i + 1}`
    )
      .trim()
      .slice(0, 160);
    // Every character is analyzed once, in bounded chunks. No beginning-only
    // sampling that silently ignores a late chapter's climax.
    for (let offset = 0, chunk = 0; offset < text.length; offset += 8000, chunk++) {
      if (sections.length >= LITERARY_SECTION_LIMIT || totalChars >= LITERARY_TEXT_LIMIT) {
        truncated = true;
        break outer;
      }
      const end = Math.min(text.length, offset + 8000, offset + LITERARY_TEXT_LIMIT - totalChars);
      sections.push({
        id: `s${String(i).padStart(5, "0")}_${String(chunk).padStart(5, "0")}`,
        spineIndex: i,
        href,
        title,
        chunkIndex: chunk,
        charStart: offset,
        charEnd: end,
        text: text.slice(offset, end),
      });
      totalChars += end - offset;
    }
  }
  return { sections, totalChars, truncated, spineItems: spine.length };
}
