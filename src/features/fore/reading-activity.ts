import { api } from "./client";
import { countWords } from "./domain";
import { putRecord, getRecords, deleteRecord } from "./offline";
type Session = {
  id: string;
  bookId: string;
  mode: "read" | "listen";
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  wordsRead: number;
};
export async function flushSessions(userId: string) {
  for (const row of await getRecords<any>("outbox")) {
    if (row.userId !== userId) continue;
    try {
      await api("/sessions", "PUT", row.session);
      await deleteRecord("outbox", row.id);
    } catch (error) {
      if ([400, 404, 409].includes((error as any).status)) {
        await deleteRecord("outbox", row.id);
        continue;
      }
      break;
    }
  }
}
export function createActivity(bookId: string, userId: string | null, mode: "read" | "listen") {
  let session: Session = {
    id: sessionId(),
    bookId,
    mode,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    activeSeconds: 0,
    wordsRead: 0,
  };
  let active = 0,
    words = 0,
    last = performance.now(),
    lastInteraction = performance.now(),
    playing = false,
    visibleWords = 0,
    dwell = 0;
  const visited = new Set<string>();
  let locator = "";
  let saving = Promise.resolve();
  function tick() {
    const current = performance.now(),
      elapsed = Math.min(5, (current - last) / 1000);
    last = current;
    const focused =
      mode === "listen"
        ? playing
        : document.visibilityState === "visible" && current - lastInteraction < 90000;
    if (focused) {
      active += elapsed;
      if (mode === "read") dwell += elapsed;
    }
  }
  function accountPage() {
    if (locator && !visited.has(locator) && dwell >= 2) {
      words += Math.min(visibleWords, Math.floor(dwell * 12));
      visited.add(locator);
    }
    dwell = 0;
  }
  function interact() {
    lastInteraction = performance.now();
  }
  const interval = setInterval(tick, 1000);
  const saveInterval = setInterval(() => {
    if (active >= 4 * 3600) {
      accountPage();
      void save();
      session = { ...session, id: sessionId(), startedAt: new Date().toISOString() };
      active = 0;
      words = 0;
      visited.clear();
    } else void save();
  }, 15000);
  document.addEventListener("pointerdown", interact);
  document.addEventListener("keydown", interact);
  document.addEventListener("scroll", interact, true);
  function snapshot() {
    tick();
    const pending =
      locator && !visited.has(locator) && dwell >= 2
        ? Math.min(visibleWords, Math.floor(dwell * 12))
        : 0;
    return {
      ...session,
      endedAt: new Date().toISOString(),
      activeSeconds: Math.floor(active),
      wordsRead: Math.min(words + pending, Math.floor(active * 25)),
    };
  }
  async function save() {
    if (!userId || active < 2) return;
    const value = snapshot();
    saving = saving
      .catch(() => {})
      .then(async () => {
        await putRecord("outbox", { id: value.id, userId, session: value }).catch(() => {});
        try {
          await api("/sessions", "PUT", value);
          await deleteRecord("outbox", value.id);
        } catch {
          /* Retained for the same signed-in user's next connection. */
        }
      });
    await saving;
  }
  const hide = () => {
    if (document.visibilityState === "hidden") void save();
  };
  document.addEventListener("visibilitychange", hide);
  return {
    page(cfi: string, text: string) {
      tick();
      if (cfi === locator) return;
      accountPage();
      locator = cfi;
      visibleWords = countWords(text);
      interact();
    },
    interact,
    setPlaying(value: boolean) {
      tick();
      playing = value;
    },
    save,
    stop() {
      tick();
      accountPage();
      clearInterval(interval);
      clearInterval(saveInterval);
      document.removeEventListener("pointerdown", interact);
      document.removeEventListener("keydown", interact);
      document.removeEventListener("scroll", interact, true);
      document.removeEventListener("visibilitychange", hide);
      void save();
    },
  };
}
export async function measureEpub(info: any) {
  const zip = info.zip,
    xml = await zip.file("META-INF/container.xml").async("string"),
    container = new DOMParser().parseFromString(xml, "application/xml");
  const opfPath = container.getElementsByTagName("rootfile")[0].getAttribute("full-path")!;
  const opf = new DOMParser().parseFromString(
    await zip.file(opfPath).async("string"),
    "application/xml",
  );
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const manifest = new Map(
    Array.from(opf.getElementsByTagName("item")).map((item: any) => [
      item.getAttribute("id"),
      item,
    ]),
  );
  let words = 0,
    syllables = 0,
    sentences = 0;
  for (const ref of Array.from(opf.getElementsByTagName("itemref"))) {
    if (ref.getAttribute("linear") === "no") continue;
    const item: any = manifest.get(ref.getAttribute("idref"));
    if (!item || /nav/.test(item.getAttribute("properties") || "")) continue;
    const href = item.getAttribute("href");
    const resolved = decodeURIComponent(
      new URL(href, "https://epub.invalid/" + base).pathname.slice(1),
    );
    const file = zip.file(resolved);
    if (!file) continue;
    const doc = new DOMParser().parseFromString(
      await file.async("string"),
      "application/xhtml+xml",
    );
    doc.querySelectorAll('script,style,nav,[epub\\:type="toc"]').forEach((n) => n.remove());
    const text = (doc.querySelector("body")?.textContent || "").replace(/\s+/g, " ");
    const tokens = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || [];
    words += tokens.length;
    sentences += Math.max(1, (text.match(/[.!?]+(?:\s|$)/g) || []).length);
    if (info.language?.startsWith("en"))
      for (const word of tokens) {
        const w = word
          .toLowerCase()
          .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
          .replace(/^y/, "");
        syllables += Math.max(1, (w.match(/[aeiouy]{1,2}/g) || []).length);
      }
  }
  const language = info.language?.split("-")[0] || "en";
  return {
    wordCount: words,
    readingLevel:
      language === "en" && words
        ? Math.max(
            -20,
            Math.min(
              100,
              0.39 * (words / Math.max(1, sentences)) + 11.8 * (syllables / words) - 15.59,
            ),
          )
        : null,
    language,
  };
}

function sessionId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
