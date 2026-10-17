import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
/** Validate the archive/package before labeling an upstream transfer as stored.
 * Bound expanded size before inflating XML, so malformed or bomb archives fail.
 * Regional sources additionally pass their existing canonicalization/rights gate.
 */
export async function validateStoredEpub(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  let expanded = 0;
  for (const entry of entries) {
    const size =
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0;
    expanded += size;
    if (entry.name.startsWith("/") || entry.name.split("/").includes(".."))
      throw new Error("Unsafe EPUB archive path.");
  }
  if (entries.length > 3000 || expanded > 60 * 1024 * 1024)
    throw new Error("EPUB expands beyond the reading limit.");
  const xml = async (name: string, max = 1024 * 1024) => {
    const entry = zip.file(name);
    if (
      !entry ||
      ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ||
        0) > max
    )
      throw new Error("EPUB package metadata is missing or too large.");
    return entry.async("string");
  };
  if ((await xml("mimetype", 100)) !== "application/epub+zip")
    throw new Error("Invalid EPUB mimetype.");
  const parse = (text: string) => {
    if (/<!ENTITY\b/i.test(text)) throw new Error("EPUB metadata cannot declare XML entities.");
    return new DOMParser({
      errorHandler: {
        warning: () => {
          throw new Error("Invalid EPUB XML metadata.");
        },
        error: () => {
          throw new Error("Invalid EPUB XML metadata.");
        },
        fatalError: () => {
          throw new Error("Invalid EPUB XML metadata.");
        },
      },
    }).parseFromString(text, "application/xml");
  };
  const container = parse(await xml("META-INF/container.xml"));
  const packagePath = container
    .getElementsByTagNameNS("*", "rootfile")[0]
    ?.getAttribute("full-path");
  if (!packagePath || packagePath.split("/").includes("..") || packagePath.startsWith("/"))
    throw new Error("EPUB package path is invalid.");
  const opf = parse(await xml(packagePath));
  if (opf.documentElement.localName !== "package") throw new Error("Invalid EPUB package root.");
  const items = new Map(
    Array.from(opf.getElementsByTagNameNS("*", "item")).map((item) => [
      item.getAttribute("id"),
      item.getAttribute("href"),
    ]),
  );
  const spine = Array.from(opf.getElementsByTagNameNS("*", "itemref"));
  if (!spine.length) throw new Error("EPUB package has no readable spine.");
  for (const ref of spine) {
    const href = items.get(ref.getAttribute("idref"));
    if (!href) throw new Error("EPUB spine references a missing manifest item.");
    const target = new URL(href, "https://epub.invalid/" + packagePath);
    if (
      target.origin !== "https://epub.invalid" ||
      !zip.file(decodeURIComponent(target.pathname.slice(1)))
    )
      throw new Error("EPUB spine references a missing or remote chapter.");
    const chapterPath = decodeURIComponent(target.pathname.slice(1));
    const chapter = await xml(chapterPath, 60 * 1024 * 1024);
    parse(chapter);
  }
  if (zip.file("META-INF/encryption.xml"))
    throw new Error("Encrypted EPUBs require publisher handling.");
}
