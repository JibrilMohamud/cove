const ALLOWED = new Set(["B", "STRONG", "I", "EM", "U", "UL", "OL", "LI", "P", "BR", "BLOCKQUOTE"]);

export function sanitizeNoteHtml(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") return html.replace(/<[^>]+>/g, " ");
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as HTMLElement;
        if (!ALLOWED.has(element.tagName)) {
          element.replaceWith(...Array.from(element.childNodes));
          continue;
        }
        for (const attribute of Array.from(element.attributes))
          element.removeAttribute(attribute.name);
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

export function noteHtmlToMarkdown(html: string): string {
  if (!html) return "";
  const safe = sanitizeNoteHtml(html);
  if (typeof DOMParser === "undefined") return safe.replace(/<[^>]+>/g, " ").trim();
  const doc = new DOMParser().parseFromString(`<div>${safe}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";

  const convert = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as HTMLElement;
    const content = Array.from(element.childNodes).map(convert).join("");
    switch (element.tagName) {
      case "B":
      case "STRONG":
        return `**${content}**`;
      case "I":
      case "EM":
        return `*${content}*`;
      case "U":
        return content;
      case "BR":
        return "\n";
      case "LI":
        return `- ${content.trim()}\n`;
      case "P":
        return `${content.trim()}\n\n`;
      case "BLOCKQUOTE":
        return `> ${content.trim()}\n\n`;
      default:
        return content;
    }
  };

  return convert(root)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
