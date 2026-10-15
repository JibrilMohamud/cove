import { mergeMarginHighlights } from "./margin-passages";
import { DiscussionThread } from "./Community";
import {
  MemberPicker,
  type HighlightShareAudience,
  type HighlightShareState,
  type ShareMember,
} from "./Sharing";
import { openBiosync, resolveAudio, resolveText, matchingEpub } from "./biosync-client";
import { Headphones } from "lucide-react";
import { createActivity, measureEpub } from "./reading-activity";
import { flushReaderMutations, queueReaderMutation } from "./offline-reader-mutations";
import { offlineAccountId } from "./offline-account";
import { useStorefrontLocale } from "./localization";
import { cachedReaderPosition, saveCachedReaderPosition } from "./offline-reading-position";
import { sha256 } from "./offline";
import { loadEdition } from "./audio-client";
import { cueForAudio, type AudioEdition } from "./domain";
import { loadBookMetadata } from "./epub";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
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
  Menu,
} from "lucide-react";
import { toast } from "sonner";

type ReaderHighlightVisibility = HighlightShareAudience["visibility"] | "private";
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
import {
  api,
  useAccount,
  findLibraryBook,
  colors,
  type CatalogBook,
  type Annotation,
  type TextBookmark,
} from "./client";
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
// epub.js returns the insertion point of a CFI in its sampled ranges. That
// rounds forward (even to 100% on short books). Use the preceding sample so
// rendering a passage never claims unread text beyond it.
function conservativeCfiProgress(
  book: { locations: { locationFromCfi(cfi: string): number; total: number } },
  cfi: string,
) {
  const index = book.locations.locationFromCfi(cfi);
  return Math.max(0, index - 1) / Math.max(1, book.locations.total);
}
export function ReaderPage({ id }: { id: string }) {
  const { t: tr } = useStorefrontLocale();
  const queryClient = useQueryClient();
  const searchString = useRouterState({ select: (state) => state.location.searchStr || "" });
  const previewMode = new URLSearchParams(searchString).get("preview") === "1";
  const bookQuery = useQuery<CatalogBook>({
    queryKey: ["book", id],
    queryFn: () => loadBookMetadata(id),
  });
  const { data, loading: accountLoading, reload, signIn } = useAccount();
  // A remembered account may write private device-only changes while the
  // network is absent. It is never used to authorize server/social actions.
  const offlineOwner = () =>
    typeof navigator !== "undefined" && navigator.onLine === false ? offlineAccountId() : "";
  const privateReaderOwner = () => accountRef.current.user?.id || offlineOwner();

  // Reader presence is a short-lived lease, scoped to this browser tab. It suppresses
  // outbound notification delivery even when the reader has requested all topics.
  const readerPresenceId = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!data.user?.id) return;
    const userId = data.user.id;
    const drain = () => {
      void flushReaderMutations(userId)
        .then(() => reload())
        .catch(() => {});
    };
    const timer = window.setInterval(drain, 60000);
    window.addEventListener("online", drain);
    void flushReaderMutations(userId).catch(() => {});
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", drain);
    };
  }, [data.user?.id]);
  useEffect(() => {
    if (!data.user?.id || accountLoading) return;
    const clientId = readerPresenceId.current;
    const renew = () => {
      if (document.visibilityState !== "visible") return;
      // Navigation or browser termination can cancel unload-time fetches.
      // The lease expires naturally when the reader closes; while visible,
      // regular renewals prevent any outbound notification interruptions.
      void api("/notifications/reader-presence", "POST", {
        clientId,
        reading: true,
      }).catch(() => {});
    };
    renew();
    const timer = window.setInterval(renew, 45000);
    document.addEventListener("visibilitychange", renew);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", renew);
    };
  }, [data.user?.id, accountLoading]);
  const bookReferences = useRef(new Set<string>([id]));
  const metadata = bookQuery.data;
  bookReferences.current = new Set(
    [
      id,
      metadata?.id,
      metadata?.publicProductId,
      metadata?.productId,
      ...(metadata?.sourceName === "gutenberg" ? [metadata.sourceExternalId] : []),
    ]
      .filter((ref) => ref !== undefined && ref !== null)
      .map(String),
  );
  const matchesReadingBook = (ref: string) => bookReferences.current.has(String(ref));
  const annotationBookRef =
    metadata?.sourceName === "gutenberg" && metadata.sourceExternalId
      ? String(metadata.sourceExternalId)
      : id;
  const bookAnnotationPages = useInfiniteQuery<{
    items: Annotation[];
    hasMore: boolean;
    nextOffset: number;
  }>({
    queryKey: ["reader-annotation-pages", data.user?.id, annotationBookRef],
    queryFn: ({ pageParam }) =>
      api(
        "/account/collection?kind=annotations&bookId=" +
          encodeURIComponent(annotationBookRef) +
          "&offset=" +
          String(pageParam || 0),
      ),
    initialPageParam: 0,
    getNextPageParam: (page) => (page.hasMore ? page.nextOffset : undefined),
    enabled: !!data.user && !previewMode,
    staleTime: 30_000,
  });
  const readerAnnotations = useMemo(() => {
    const byId = new Map<string, Annotation>();
    for (const annotation of data.annotations)
      if (bookReferences.current.has(String(annotation.bookId)))
        byId.set(annotation.id, annotation);
    for (const page of bookAnnotationPages.data?.pages || [])
      for (const annotation of page.items) byId.set(annotation.id, annotation);
    return [...byId.values()];
  }, [data.annotations, bookAnnotationPages.data, annotationBookRef]);

  const activity = useRef<ReturnType<typeof createActivity> | null>(null),
    epubHash = useRef(""),
    sync = useRef<Awaited<ReturnType<typeof openBiosync>> | null>(null),
    syncEdition = useRef<AudioEdition | null>(null),
    initialAnchor = useRef(""),
    anchorPage = useRef(""),
    syncConflict = useRef(false);
  const editions = useQuery<{ results: AudioEdition[] }>({
    queryKey: ["book-audio", id],
    queryFn: () => api("/audiobooks?bookId=" + id),
  });
  const container = useRef<HTMLDivElement>(null),
    rendition = useRef<any>(null),
    epub = useRef<any>(null),
    mounted = useRef(false),
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    position = useRef({ cfi: "", progress: 0, atEnd: false }),
    advancedPage = useRef(false),
    accountRef = useRef(data),
    chapterRef = useRef(""),
    annotationRef = useRef(data.annotations),
    savingPosition = useRef(Promise.resolve()),
    savedPositionKey = useRef(""),
    recommendationStart = useRef(""),
    recommendationProgressBucket = useRef(-1),
    savedSpoilerPercent = useRef(-1),
    readingVersion = useRef(0),
    readingScope = useRef(""),
    positionConflict = useRef(false),
    previewVersion = useRef(0),
    settingVersions = useRef<Record<string, number>>({}),
    lastSyncedSettings = useRef<Record<string, unknown>>({}),
    settingSyncReady = useRef(false),
    settingSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    chromeHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    chromeVisibleRef = useRef(false);
  accountRef.current = data;
  annotationRef.current = readerAnnotations;
  useEffect(() => {
    const known = findLibraryBook(data.library, id);
    if (data.user?.id && known?.cfi)
      void saveCachedReaderPosition(data.user.id, id, {
        cfi: known.cfi,
        progress: known.progress || 0,
        version: known.version || 0,
      }).catch(() => {});
  }, [data.user?.id, data.library, id]);
  useEffect(() => {
    const scope = JSON.stringify([data.user?.id || offlineOwner(), id]);
    const version = findLibraryBook(data.library, id)?.version || 0;
    if (readingScope.current !== scope) {
      readingScope.current = scope;
      readingVersion.current = version;
      savedPositionKey.current = "";
      positionConflict.current = false;
      advancedPage.current = false;
    } else {
      // A reload started before our save can finish with an older snapshot.
      readingVersion.current = Math.max(readingVersion.current, version);
    }
  }, [data.library, data.user?.id, id]);
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
    [socialCompose, setSocialCompose] = useState<"discussion" | "share" | null>(null),
    [socialBody, setSocialBody] = useState(""),
    [discussionDirect, setDiscussionDirect] = useState(false),
    [discussionVisibility, setDiscussionVisibility] = useState<
      "public" | "followers" | "friends" | "group"
    >("friends"),
    [discussionGroupId, setDiscussionGroupId] = useState(""),
    [discussionMember, setDiscussionMember] = useState<ShareMember | null>(null),
    [discussionAudienceConfirmed, setDiscussionAudienceConfirmed] = useState(false),
    [socialVisibility, setSocialVisibility] = useState<
      "private" | "public" | "followers" | "friends" | "group" | "member"
    >("private"),
    [socialGroupId, setSocialGroupId] = useState(""),
    [socialMember, setSocialMember] = useState<ShareMember | null>(null),
    [socialShareNote, setSocialShareNote] = useState(false),
    [socialAudienceConfirmed, setSocialAudienceConfirmed] = useState(false),
    [socialConfirmedAnnotationVersion, setSocialConfirmedAnnotationVersion] = useState<
      number | null
    >(null),
    [socialAnnotationId, setSocialAnnotationId] = useState<string | null>(null),
    [socialBusy, setSocialBusy] = useState(false),
    [activeSocialHash, setActiveSocialHash] = useState<string | null>(null),
    [finishedJourney, setFinishedJourney] = useState<string | null>(null),
    [chromeVisible, setChromeVisible] = useState(false),
    [formatInfo, setFormatInfo] = useState<{
      fixedLayout: boolean;
      rtl: boolean;
      verticalWriting: boolean;
      epubVersion: string;
      navigationType: string;
      pageProgressionDirection: string;
    }>({
      fixedLayout: false,
      rtl: false,
      verticalWriting: false,
      epubVersion: "EPUB",
      navigationType: "unknown",
      pageProgressionDirection: "default",
    });
  const formatRef = useRef(formatInfo);
  formatRef.current = formatInfo;
  chromeVisibleRef.current = chromeVisible;

  function cancelChromeHide() {
    if (chromeHideTimer.current) {
      clearTimeout(chromeHideTimer.current);
      chromeHideTimer.current = null;
    }
  }
  function hideChrome() {
    cancelChromeHide();
    chromeVisibleRef.current = false;
    setChromeVisible(false);
  }
  function scheduleChromeHide(delay = 4200) {
    cancelChromeHide();
    chromeHideTimer.current = setTimeout(() => {
      chromeHideTimer.current = null;
      chromeVisibleRef.current = false;
      setChromeVisible(false);
    }, delay);
  }
  function showChrome(autoHide = true) {
    chromeVisibleRef.current = true;
    setChromeVisible(true);
    if (autoHide) scheduleChromeHide();
    else cancelChromeHide();
  }
  function toggleChrome() {
    if (chromeVisibleRef.current) hideChrome();
    else showChrome();
  }
  useEffect(
    () => () => {
      if (chromeHideTimer.current) clearTimeout(chromeHideTimer.current);
    },
    [],
  );
  const finishedJourneyAudience = useQuery<{ visibility: "private" | "followers" | "public" }>({
    queryKey: ["finished-journey-audience", data.user?.id, finishedJourney],
    queryFn: () => api(`/social/journeys/${encodeURIComponent(finishedJourney || "")}`),
    enabled: !!data.user && !!finishedJourney,
  });
  const selectedShare = useQuery<HighlightShareState>({
    queryKey: ["highlight-share", data.user?.id, socialAnnotationId],
    queryFn: () => api(`/social/highlights/${encodeURIComponent(socialAnnotationId!)}/share`),
    enabled: !!data.user && !!socialAnnotationId && socialCompose === "share",
  });
  const socialReaderQuery = useInfiniteQuery<any>({
    queryKey: ["social-reader", id, data.user?.id],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api(
        `/social/reader/${encodeURIComponent(id)}${pageParam ? `?cursor=${encodeURIComponent(String(pageParam))}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: !!data.user && !previewMode,
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.pages[0]?.preferences?.enabled ? 60_000 : false),
  });
  const clusters = new Map<string, any>();
  for (const page of socialReaderQuery.data?.pages || [])
    for (const cluster of page.indicators || []) {
      const previous = clusters.get(cluster.passageHash);
      const posts = [
        ...new Map(
          [...(previous?.posts || []), ...cluster.posts].map((p: any) => [p.id, p]),
        ).values(),
      ];
      const highlights = mergeMarginHighlights(previous?.highlights || [], cluster.highlights);
      clusters.set(cluster.passageHash, {
        ...cluster,
        posts,
        highlights,
        discussionCount: posts.length,
        highlightCount: highlights.length,
      });
    }
  const socialReader = {
    ...socialReaderQuery,
    data: socialReaderQuery.data
      ? {
          ...socialReaderQuery.data.pages[0],
          indicators: [...clusters.values()],
          totalVisible: clusters.size,
        }
      : undefined,
  };
  const activeSocial = clusters.get(activeSocialHash || "") || null;
  const [passageMarkers, setPassageMarkers] = useState<
    { hash: string; top: number; count: number; passage: string; chapter: string }[]
  >([]);
  useEffect(() => {
    if (!socialReader.data?.preferences?.enabled) {
      setPassageMarkers([]);
      return;
    }
    let canceled = false;
    function measure() {
      const stage = container.current?.closest(".reader-stage");
      if (!stage || !rendition.current) return;
      const stageRect = stage.getBoundingClientRect(),
        markers: {
          hash: string;
          top: number;
          count: number;
          passage: string;
          chapter: string;
        }[] = [];
      for (const cluster of socialReader.data?.indicators || []) {
        if (!cluster.cfi) continue;
        for (const contents of rendition.current.getContents()) {
          try {
            const parsed = new contents.epubcfi.constructor(cluster.cfi);
            if (parsed.spinePos !== contents.sectionIndex) continue;
            const range = contents.range(cluster.cfi),
              frame = contents.window.frameElement;
            if (!range || !frame) continue;
            if (range.collapsed && range.startContainer.nodeType === 3) {
              const length = range.startContainer.textContent?.length || 0;
              if (range.startOffset < length)
                range.setEnd(range.startContainer, range.startOffset + 1);
              else if (range.startOffset > 0)
                range.setStart(range.startContainer, range.startOffset - 1);
            }
            const rects = Array.from(range.getClientRects()) as DOMRect[];
            const frameRect = frame.getBoundingClientRect();
            const rect = rects.find(
              (rect) =>
                rect.width > 0 &&
                rect.height > 0 &&
                rect.left >= 0 &&
                rect.left < frameRect.width &&
                frameRect.left + rect.left >= stageRect.left &&
                frameRect.left + rect.left < stageRect.right &&
                rect.top >= 0 &&
                rect.top < frameRect.height,
            );
            if (!rect) continue;
            const top = frameRect.top + rect.top - stageRect.top;
            if (top < 0 || top > stageRect.height - 30) continue;
            markers.push({
              hash: cluster.passageHash,
              top,
              count: cluster.discussionCount + cluster.highlightCount,
              chapter: String(cluster.chapter || "the current chapter"),
              passage: String(
                cluster.posts?.[0]?.passageText || cluster.highlights?.[0]?.quote || "",
              )
                .replace(/\s+/g, " ")
                .slice(0, 120),
            });
            break;
          } catch {
            /* CFI belongs to a different spine document. */
          }
        }
      }
      const density = Number(socialReader.data?.preferences?.density ?? 35),
        max = density === 0 ? 0 : density < 20 ? 1 : density < 67 ? 2 : 3;
      const visible: typeof markers = [];
      for (const marker of markers.sort((a, b) => b.count - a.count))
        if (visible.length < max && !visible.some((m) => Math.abs(m.top - marker.top) < 32))
          visible.push(marker);
      if (!canceled)
        setPassageMarkers((previous) =>
          JSON.stringify(previous) === JSON.stringify(visible) ? previous : visible,
        );
    }
    let frame: number | null = null;
    const schedule = () => {
      if (canceled || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!canceled) measure();
      });
    };
    const currentRendition = rendition.current;
    const stage = container.current?.closest(".reader-stage");
    const observer = new ResizeObserver(schedule);
    if (stage) {
      observer.observe(stage);
      stage.addEventListener("scroll", schedule, { passive: true });
    }
    const contents = currentRendition?.getContents() || [];
    for (const content of contents) {
      content.window.addEventListener("scroll", schedule, { passive: true });
      void content.document.fonts?.ready.then(schedule);
    }
    for (const event of ["rendered", "relocated", "resized", "layout"])
      currentRendition?.on(event, schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      canceled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      stage?.removeEventListener("scroll", schedule);
      for (const content of contents) content.window.removeEventListener("scroll", schedule);
      for (const event of ["rendered", "relocated", "resized", "layout"])
        currentRendition?.off(event, schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [socialReaderQuery.data, percent, chapter, ready]);
  const socialAccount = useQuery<{
    groups: { id: string; name: string; member_status: string; status?: string }[];
    profile?: { highlight_visibility_default?: string | null } | null;
  }>({
    queryKey: ["social-me-reader", data.user?.id],
    queryFn: () => api("/social/me"),
    enabled: !!data.user && !previewMode,
    staleTime: 15000,
  });
  const activeGroups = (socialAccount.data?.groups || []).filter(
    (group) => group.member_status === "active" && group.status !== "suspended",
  );
  const discussionGroupName = activeGroups.find((group) => group.id === discussionGroupId)?.name;
  const highlightGroupName = activeGroups.find((group) => group.id === socialGroupId)?.name;
  const discussionAudienceLabel = discussionDirect
    ? `@${discussionMember?.username || "selected member"}`
    : discussionVisibility === "group"
      ? discussionGroupName || "a reading group"
      : {
          friends: "friends / mutuals",
          followers: "your followers",
          public: "the public",
        }[discussionVisibility];
  const highlightAudienceLabel =
    socialVisibility === "private"
      ? "private (not shared)"
      : socialVisibility === "member"
        ? `@${socialMember?.username || "selected member"}`
        : socialVisibility === "group"
          ? highlightGroupName || "a reading group"
          : {
              friends: "friends / mutuals",
              followers: "followers",
              public: "the public",
            }[socialVisibility];
  const highlightAudienceKey =
    socialVisibility === "member"
      ? socialMember
        ? `member:${socialMember.id}`
        : ""
      : socialVisibility === "group"
        ? socialGroupId
          ? `group:${socialGroupId}`
          : ""
        : socialVisibility;
  const selectedAudienceShare = selectedShare.data?.shares.find(
    (share) => share.audienceKey === highlightAudienceKey,
  );
  const selectedAudienceAlreadyShared = !!selectedAudienceShare;
  const highlightConfirmationCurrent =
    socialAudienceConfirmed &&
    (!socialShareNote ||
      socialConfirmedAnnotationVersion === selectedShare.data?.annotationVersion);
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
  useEffect(() => {
    if (!data.user) {
      settingSyncReady.current = false;
      settingVersions.current = {};
      lastSyncedSettings.current = {};
      return;
    }
    let canceled = false;
    (async () => {
      try {
        const remote = await loadSyncedReaderSettings(data.user!.id);
        if (canceled) return;
        settingVersions.current = Object.fromEntries(
          Object.entries(remote.settings).map(([k, v]) => [k, v.version]),
        );
        const seen: Record<string, unknown> = {};
        const get = (key: string) => remote.settings[key]?.value;
        if (typeof get("reader.fontSize") === "number") {
          setFontSize(get("reader.fontSize"));
          seen["reader.fontSize"] = get("reader.fontSize");
        }
        if (typeof get("reader.lineHeight") === "number") {
          setLineHeight(get("reader.lineHeight"));
          seen["reader.lineHeight"] = get("reader.lineHeight");
        }
        if (["publisher", "serif", "sans-serif"].includes(String(get("reader.font")))) {
          setFont(String(get("reader.font")));
          seen["reader.font"] = get("reader.font");
        }
        if (String(get("reader.theme")) in themes) {
          setTheme(String(get("reader.theme")) as keyof typeof themes);
          seen["reader.theme"] = get("reader.theme");
        }
        if (["paginated", "scrolled-doc"].includes(String(get("reader.flow")))) {
          setFlow(String(get("reader.flow")));
          seen["reader.flow"] = get("reader.flow");
        }
        lastSyncedSettings.current = seen;
        settingSyncReady.current = true;
      } catch {
        settingSyncReady.current = false;
      }
    })();
    return () => {
      canceled = true;
    };
  }, [data.user?.id]);
  function applySettings(r: any) {
    const s = settings.current,
      t = themes[s.theme];
    if (formatRef.current.fixedLayout) return;
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
    if (positionConflict.current) return;
    const p = position.current;
    if (!p.cfi) return;
    if (!previewMode && syncEdition.current && sync.current) {
      try {
        const m = await resolveText(syncEdition.current, p.cfi, epubHash.current);
        if (m) await sync.current.save(syncEdition.current, m, "text");
      } catch (error) {
        setSaveState((error as Error).message);
        if ((error as any).status === 409) syncConflict.current = true;
      }
    }
    const ownerId = privateReaderOwner();
    if (!ownerId || (previewMode && !accountRef.current.user)) return;
    const scope = readingScope.current;
    const key = JSON.stringify([ownerId, id, previewMode, p.cfi, p.progress]);
    if (savedPositionKey.current === key) return;
    setSaveState(previewMode ? "Saving sample position…" : "Saving position…");
    const snapshot = { ...p };
    savingPosition.current = savingPosition.current
      .catch(() => {})
      .then(async () => {
        if (
          positionConflict.current ||
          readingScope.current !== scope ||
          privateReaderOwner() !== ownerId
        )
          return;
        try {
          if (savedPositionKey.current === key) {
            if (mounted.current) setSaveState("Position saved");
            return;
          }
          if (previewMode) {
            const productId = bookQuery.data?.productId;
            if (productId) {
              const saved = await api<{ version: number }>("/preview/state", "POST", {
                productId,
                cfi: snapshot.cfi,
                progress: snapshot.progress,
                expectedVersion: previewVersion.current,
              });
              previewVersion.current = saved.version;
            }
          } else {
            await saveCachedReaderPosition(ownerId, id, {
              cfi: snapshot.cfi,
              progress: snapshot.progress,
              version: readingVersion.current,
            });
            const written = await queueReaderMutation(ownerId, "position", id, "/library", "POST", {
              bookId: id,
              status:
                (snapshot.atEnd && advancedPage.current) ||
                findLibraryBook(accountRef.current.library, id)?.status === "finished"
                  ? "finished"
                  : "reading",
              cfi: snapshot.cfi,
              progress: snapshot.progress,
              expectedVersion: readingVersion.current,
            });
            if (readingScope.current !== scope || privateReaderOwner() !== ownerId) return;
            if (written.queued) {
              savedPositionKey.current = key;
              if (mounted.current) setSaveState("Position saved on this device — pending sync");
              return;
            }
            const saved = written.response as { version: number; readingJourneyId?: string | null };
            readingVersion.current = saved.version;
            await saveCachedReaderPosition(ownerId, id, {
              cfi: snapshot.cfi,
              progress: snapshot.progress,
              version: saved.version,
            });
            if (saved.readingJourneyId && mounted.current)
              setFinishedJourney(saved.readingJourneyId);
          }
          savedPositionKey.current = key;
          const spoilerPercent = Math.floor(snapshot.progress * 100);
          if (!previewMode && spoilerPercent > savedSpoilerPercent.current) {
            savedSpoilerPercent.current = spoilerPercent;
            // Refresh only after the backend has accepted new spoiler progress.
            void socialReaderQuery.refetch();
            void queryClient.invalidateQueries({
              queryKey: ["social-posts", ownerId, "margin", id],
            });
          }
          const productId = bookQuery.data?.productId,
            bucket = Math.floor(Math.max(0, Math.min(0.999, snapshot.progress)) * 10);
          if (productId && bucket > 0 && bucket > recommendationProgressBucket.current) {
            recommendationProgressBucket.current = bucket;
            api("/recommendations/event", "POST", {
              type: "read_progress",
              productId,
              value: snapshot.progress,
              surface: "reader",
              metadata: { progressBucket: bucket },
            }).catch(() => {});
          }
          if (mounted.current) setSaveState("Position saved");
        } catch (e) {
          if ((e as any)?.status === 409) {
            positionConflict.current = true;
            if (mounted.current)
              setSaveState("Position changed on another device — reload to choose");
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
    let pageRepairTimer: ReturnType<typeof setTimeout> | undefined;
    let selectionTimer: ReturnType<typeof setTimeout> | undefined;
    let selectionPoll: ReturnType<typeof setInterval> | undefined;
    const selectionDocuments = new WeakSet<Document>();
    const blockedSelectionReaders = new WeakMap<Document, () => void>();
    let lastPolledRange:
      | {
          doc: Document;
          start: Node;
          end: Node;
          startOffset: number;
          endOffset: number;
        }
      | undefined;
    function pollBlockedSelection() {
      const frame = document.activeElement;
      if (
        canceled ||
        document.hidden ||
        !(frame instanceof HTMLIFrameElement) ||
        !container.current?.contains(frame)
      ) {
        lastPolledRange = undefined;
        return;
      }
      const doc = frame.contentDocument;
      const capture = doc && blockedSelectionReaders.get(doc);
      const selected = capture && doc?.getSelection();
      if (!capture || !doc || !selected?.rangeCount || selected.isCollapsed) {
        lastPolledRange = undefined;
        return;
      }
      const range = selected.getRangeAt(0);
      if (
        lastPolledRange?.doc === doc &&
        lastPolledRange.start === range.startContainer &&
        lastPolledRange.end === range.endContainer &&
        lastPolledRange.startOffset === range.startOffset &&
        lastPolledRange.endOffset === range.endOffset
      )
        return;
      lastPolledRange = {
        doc,
        start: range.startContainer,
        end: range.endContainer,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
      };
      capture();
    }
    function presentSelection(cfi: string, text: string) {
      if (canceled || !text) return;
      const next = { cfi, text: text.slice(0, 12000), chapter: chapterRef.current };
      setSelection((current) =>
        current?.cfi === next.cfi && current.text === next.text && current.chapter === next.chapter
          ? current
          : next,
      );
      setActiveAnnotation(null);
    }
    (async () => {
      const params = new URLSearchParams(location.search);
      if (!previewMode) {
        sync.current = await openBiosync(id, accountRef.current.user?.id || null);
        const preferred = params.get("audioEdition") || sync.current.current?.edition_id;
        if (preferred) {
          try {
            const e = await loadEdition(preferred);
            if (e.bookId === id && e.alignment?.version === 2) syncEdition.current = e;
          } catch {}
        }
        if (!syncEdition.current) {
          try {
            const r = await api("/audiobooks?bookId=" + id);
            syncEdition.current =
              r.results.find((e: AudioEdition) => e.alignment?.version === 2) || null;
          } catch {}
        }
      }
      const [{ default: ePub }, bytes] = await Promise.all([
        import("epubjs"),
        !previewMode && syncEdition.current
          ? matchingEpub(syncEdition.current)
          : epubBytes(id, previewMode),
      ]);
      if (canceled) return;
      epubHash.current = await sha256(bytes);
      const clean = await prepareEpub(bytes);
      const detected = {
        fixedLayout: !!clean.metadata.fixedLayout,
        rtl: !!clean.metadata.rtl,
        verticalWriting: !!clean.metadata.verticalWriting,
        epubVersion: String(clean.metadata.epubVersion || "EPUB"),
        navigationType: String(clean.metadata.navigationType || "unknown"),
        pageProgressionDirection: String(clean.metadata.pageProgressionDirection || "default"),
      };
      formatRef.current = detected;
      setFormatInfo(detected);
      if (detected.fixedLayout && flow !== "paginated") setFlow("paginated");
      if (accountRef.current.user && !previewMode)
        measureEpub(clean.metadata)
          .then((metrics) => api("/metrics", "PUT", { bookId: id, ...metrics }))
          .catch(() => {});
      activity.current = createActivity(id, privateReaderOwner() || null, "read");
      const recommendationProductId = bookQuery.data?.productId;
      if (
        accountRef.current.user &&
        recommendationProductId &&
        recommendationStart.current !== recommendationProductId
      ) {
        recommendationStart.current = recommendationProductId;
        recommendationProgressBucket.current = -1;
        api("/recommendations/event", "POST", {
          type: previewMode ? "sample_start" : "read_start",
          productId: recommendationProductId,
          surface: previewMode ? "preview" : "reader",
        }).catch(() => {});
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
      if (detected.rtl && typeof r.direction === "function") r.direction("rtl");
      applySettings(r);
      r.hooks.content.register((contents: any) => {
        // Capture native ranges while the document owns the selection. Safari
        // can retain the painted selection after focus changes while EPUB.js's
        // delayed window-selection lookup no longer emits a selected event.
        const doc = contents.document as Document;
        if (!selectionDocuments.has(doc)) {
          selectionDocuments.add(doc);
          const captureSelection = (immediate = false) => {
            const selected = doc.getSelection();
            if (!selected?.rangeCount || selected.isCollapsed) return;
            const range = selected.getRangeAt(0).cloneRange();
            const text = range.toString().trim();
            if (!text) return;
            if (selectionTimer) clearTimeout(selectionTimer);
            const presentRange = () => {
              selectionTimer = undefined;
              const stillDisplayed = Array.from(
                container.current?.querySelectorAll("iframe") || [],
              ).some((frame) => frame.contentDocument === doc);
              if (canceled || !stillDisplayed) return;
              try {
                presentSelection(contents.cfiFromRange(range), text);
              } catch {
                // A page turn may remove the range before it settles.
              }
            };
            if (immediate) presentRange();
            else selectionTimer = setTimeout(presentRange, 250);
          };
          for (const event of ["selectionchange", "mouseup", "touchend", "keyup"])
            doc.addEventListener(event, () => captureSelection(), { passive: true });
          // WebKit blocks even parent-owned callbacks in a script-disabled
          // frame. Detect that restriction without enabling any EPUB scripts.
          let receivesEvents = false;
          const probe = () => {
            receivesEvents = true;
          };
          doc.addEventListener("cove-selection-probe", probe);
          doc.dispatchEvent(new Event("cove-selection-probe"));
          doc.removeEventListener("cove-selection-probe", probe);
          if (!receivesEvents) {
            blockedSelectionReaders.set(doc, () => captureSelection(true));
            if (!selectionPoll) selectionPoll = setInterval(pollBlockedSelection, 250);
          }
        }
        contents.document.addEventListener("keydown", keys);
        contents.document.addEventListener("pointerdown", () => activity.current?.interact());
        contents.document.addEventListener("scroll", () => activity.current?.interact());
        contents.document.addEventListener("pointermove", (event: PointerEvent) => {
          const edge = 28;
          if (event.clientY <= edge || event.clientY >= contents.window.innerHeight - edge)
            showChrome();
        });
        contents.document.addEventListener("click", (event: Event) => {
          const anchor = (event.target as Element)?.closest?.("a");
          if (anchor && /^https?:/i.test(anchor.href)) {
            event.preventDefault();
            window.open(anchor.href, "_blank", "noopener,noreferrer");
            return;
          }
          if (anchor) return;
          const selectedText = contents.window.getSelection()?.toString().trim();
          if (!selectedText) toggleChrome();
        });
      });
      r.on("selected", (cfi: string, contents: any) => {
        const text = contents.window.getSelection()?.toString().trim();
        if (text) presentSelection(cfi, text);
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
          ? conservativeCfiProgress(created, loc.start.cfi)
          : Math.min(
              0.99,
              ((loc.start.index || 0) +
                (loc.start.displayed?.page || 0) / Math.max(1, loc.start.displayed?.total || 1)) /
                Math.max(1, created.spine.length),
            );
        if (initialAnchor.current) {
          if (!anchorPage.current) anchorPage.current = loc.start.cfi;
          else if (anchorPage.current !== loc.start.cfi) initialAnchor.current = "";
        }
        position.current = {
          cfi: initialAnchor.current || loc.start.cfi,
          progress:
            loc.atEnd && advancedPage.current
              ? 1
              : Number.isFinite(p)
                ? Math.max(0, Math.min(0.99, p))
                : 0,
          atEnd: loc.atEnd === true,
        };
        setPercent(Math.round(position.current.progress * 100));
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => persistPosition(), 1200);
      });
      r.on("markClicked", (cfi: string, mark: any) => {
        const a = annotationRef.current.find((x) => x.cfi === cfi && matchesReadingBook(x.bookId));
        if (a) {
          setActiveAnnotation(a);
          setSelection(null);
        }
      });
      r.on("displayError", (e: any) => {
        if (!canceled)
          setError("This chapter could not be displayed. Try another chapter from the contents.");
      });
      let cfi =
        new URLSearchParams(window.location.search).get("cfi") ||
        (!previewMode ? findLibraryBook(accountRef.current.library, id)?.cfi : undefined);
      if (!previewMode && !accountRef.current.user && privateReaderOwner()) {
        const local = await cachedReaderPosition(privateReaderOwner(), id);
        if (local) {
          readingVersion.current = local.version;
          if (!params.has("cfi") && local.cfi) cfi = local.cfi;
        }
      }
      if (previewMode && accountRef.current.user && bookQuery.data?.productId && !params.has("cfi"))
        try {
          const ps = await api(
            `/preview/state?productId=${encodeURIComponent(bookQuery.data.productId)}`,
          );
          previewVersion.current = Number(ps?.version || 0);
          if (ps?.cfi) cfi = ps.cfi;
        } catch {}
      const saved = sync.current?.current;
      if (!previewMode && saved && saved.epub_sha256 === epubHash.current && !params.has("cfi"))
        cfi = saved.cfi;
      if (!previewMode && params.get("audioEdition"))
        try {
          const e = await loadEdition(params.get("audioEdition")!);
          const m = await resolveAudio(e, params.get("track") || "", Number(params.get("at") || 0));
          if (e.bookId === id && e.epubSha256 === epubHash.current && m) {
            cfi = m.word.cfi;
            await sync.current?.save(e, m, "text");
            toast.message("Biosync: resumed at your spoken passage");
          } else toast.message("No checked match here. Opened your saved text position.");
        } catch (error) {
          toast.message((error as Error).message);
        }
      initialAnchor.current = cfi || "";
      anchorPage.current = "";
      try {
        await r.display(cfi || undefined);
      } catch {
        await r.display();
        toast.message("The previous location was unavailable. Opened the beginning instead.");
      }
      if (canceled) return;
      // epub.js can resolve display() before its iframe is attached on mobile WebKit.
      // A resolved promise or enabled page-turn button alone is not a readable page.
      const hasPageFrame = () => !!container.current?.querySelector("iframe");
      async function ensurePageFrame(anchor?: string) {
        if (canceled || hasPageFrame()) return;
        const host = container.current;
        if (!host) return;
        const box = host.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) r.resize(box.width, box.height);
        await r.display(anchor);
        if (!hasPageFrame()) {
          r.clear();
          await r.display();
        }
        if (!hasPageFrame())
          throw new Error("The EPUB page could not be displayed on this device. Please try again.");
      }
      await ensurePageFrame(cfi || undefined);
      if (canceled) return;
      setReady(true);
      for (const a of annotationRef.current.filter((a) => matchesReadingBook(a.bookId)))
        try {
          r.annotations.highlight(a.cfi, { id: a.id }, undefined, "fore-highlight", {
            fill: colors[a.color],
            "fill-opacity": "0.35",
            "mix-blend-mode": settings.current.theme === "night" ? "screen" : "multiply",
          });
        } catch {}
      let observedWidth = 0,
        observedHeight = 0;
      resize = new ResizeObserver(() => {
        if (container.current && rendition.current) {
          const { width, height } = container.current.getBoundingClientRect();
          if (
            width > 0 &&
            height > 0 &&
            (Math.abs(width - observedWidth) > 0.5 || Math.abs(height - observedHeight) > 0.5)
          ) {
            observedWidth = width;
            observedHeight = height;
            requestAnimationFrame(() => {
              if (!canceled) r.resize(width, height);
            });
            // epub.js clears views during resize and may not redisplay them if
            // the initial location has not been reported yet (notably on iPad).
            if (pageRepairTimer) clearTimeout(pageRepairTimer);
            pageRepairTimer = setTimeout(() => {
              if (canceled || hasPageFrame()) return;
              void ensurePageFrame(position.current.cfi || undefined).catch((error) => {
                if (canceled) return;
                setReady(false);
                setError((error as Error).message);
              });
            }, 300);
          }
        }
      });
      resize.observe(container.current!);
      // Generate CFI progress locations once, without blocking the first readable chapter.
      created.locations
        .generate(1800)
        .then(() => {
          if (!canceled && position.current.cfi) {
            const p =
              position.current.atEnd && advancedPage.current
                ? 1
                : conservativeCfiProgress(created, position.current.cfi);
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
        advancedPage.current = true;
        (formatRef.current.rtl ? rendition.current?.prev() : rendition.current?.next())?.catch?.(
          () => {},
        );
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        advancedPage.current = true;
        (formatRef.current.rtl ? rendition.current?.next() : rendition.current?.prev())?.catch?.(
          () => {},
        );
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
      if (pageRepairTimer) clearTimeout(pageRepairTimer);
      if (selectionTimer) clearTimeout(selectionTimer);
      if (selectionPoll) clearInterval(selectionPoll);
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
  useEffect(() => {
    if (!data.user || !settingSyncReady.current) return;
    const userId = data.user.id,
      values: Record<string, unknown> = {
        "reader.fontSize": fontSize,
        "reader.lineHeight": lineHeight,
        "reader.font": font,
        "reader.theme": theme,
        "reader.flow": flow,
      };
    if (settingSaveTimer.current) clearTimeout(settingSaveTimer.current);
    settingSaveTimer.current = setTimeout(async () => {
      for (const [key, value] of Object.entries(values)) {
        if (Object.is(lastSyncedSettings.current[key], value)) continue;
        try {
          const saved = await saveSyncedReaderSetting(
            userId,
            key,
            value,
            settingVersions.current[key] || 0,
          );
          settingVersions.current[key] = saved.version;
          lastSyncedSettings.current[key] = value;
        } catch (e) {
          if ((e as any)?.status === 409) {
            toast.message(
              "A reader setting changed on another device. Cove kept both versions for review and refreshed the server value.",
            );
            try {
              const remote = await loadSyncedReaderSettings(userId),
                entry = remote.settings[key];
              if (entry) {
                settingVersions.current[key] = entry.version;
                lastSyncedSettings.current[key] = entry.value;
                if (key === "reader.fontSize") setFontSize(entry.value);
                else if (key === "reader.lineHeight") setLineHeight(entry.value);
                else if (key === "reader.font") setFont(entry.value);
                else if (key === "reader.theme") setTheme(entry.value);
                else if (key === "reader.flow") setFlow(entry.value);
              }
            } catch {}
          }
        }
      }
    }, 500);
    return () => {
      if (settingSaveTimer.current) clearTimeout(settingSaveTimer.current);
    };
  }, [data.user?.id, fontSize, lineHeight, font, theme, flow]);
  useEffect(() => {
    if (rendition.current && !formatRef.current.fixedLayout) rendition.current.flow(flow);
  }, [flow]);
  useEffect(() => {
    if (!ready || !rendition.current) return;
    const r = rendition.current;
    for (const a of readerAnnotations.filter((a) => matchesReadingBook(a.bookId)))
      try {
        r.annotations.remove(a.cfi, "highlight");
        r.annotations.highlight(a.cfi, { id: a.id }, undefined, "fore-highlight", {
          fill: colors[a.color],
          "fill-opacity": "0.35",
          "mix-blend-mode": "multiply",
        });
      } catch {}
  }, [readerAnnotations, ready, id]);
  async function saveHighlight(withNote = false) {
    const ownerId = data.user?.id || offlineOwner();
    if (!ownerId) return signIn();
    if (!selection) return;
    setSaving(true);
    try {
      const clientId = crypto.randomUUID();
      const written = await queueReaderMutation(
        ownerId,
        "annotation",
        clientId,
        "/annotations",
        "POST",
        {
          clientId,
          bookId: id,
          quote: selection.text,
          cfi: selection.cfi,
          chapter: selection.chapter,
          color,
          note: withNote ? note : "",
          progress: position.current.progress,
        },
      );
      if (!written.queued) await reload();
      else setSaveState("Note saved on this device — pending sync");
      toast.success(
        written.queued
          ? "Saved on this device — the note will sync after reconnecting"
          : withNote
            ? "Highlight and note saved"
            : "Passage highlighted",
      );
      setSelection(null);
      setNoteOpen(false);
      setNote("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function publishSocialDiscussion() {
    if (!data.user) return signIn();
    if (
      socialBusy ||
      !selection ||
      !socialBody.trim() ||
      !discussionAudienceConfirmed ||
      (discussionDirect && !discussionMember) ||
      (!discussionDirect &&
        discussionVisibility === "group" &&
        !activeGroups.some((group) => group.id === discussionGroupId))
    )
      return;
    setSocialBusy(true);
    try {
      const visibility = discussionDirect ? "member" : discussionVisibility;
      await api("/social/posts", "POST", {
        contextType: "margin",
        contextId: id,
        bookId: id,
        cfi: selection.cfi,
        chapter: selection.chapter,
        progress: position.current.progress,
        passageText: selection.text,
        body: socialBody,
        groupId: visibility === "group" ? discussionGroupId : null,
        recipientUserId: discussionDirect ? discussionMember?.id : null,
        visibility,
        spoiler: false,
        audienceConfirmed: true,
      });
      setSocialBody("");
      setSocialCompose(null);
      setSelection(null);
      await socialReader.refetch();
      toast.success("Margin discussion posted");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSocialBusy(false);
    }
  }
  async function openHighlightSharing(annotation: Annotation | null = null) {
    if (!data.user) return signIn();
    if (socialBusy || (!annotation && !selection)) return;
    const owner = data.user.id;
    const passage = annotation
      ? { text: annotation.quote, cfi: annotation.cfi, chapter: annotation.chapter }
      : selection;
    setSocialBusy(true);
    try {
      const current = await socialAccount.refetch();
      if (current.error) throw current.error;
      if (accountRef.current.user?.id !== owner || !mounted.current) return;
      const savedDefault = current.data?.profile?.highlight_visibility_default || "private";
      setSelection(passage);
      setSocialVisibility(
        ["public", "followers", "friends", "private"].includes(savedDefault)
          ? (savedDefault as ReaderHighlightVisibility)
          : "private",
      );
      setSocialGroupId("");
      setSocialMember(null);
      setSocialAudienceConfirmed(false);
      setSocialConfirmedAnnotationVersion(null);
      setSocialAnnotationId(annotation?.id || null);
      setSocialShareNote(false);
      setActiveAnnotation(null);
      setPanel("");
      setSocialCompose("share");
    } catch {
      toast.error("Could not check your sharing default. Try again.");
    } finally {
      setSocialBusy(false);
    }
  }
  async function shareSelectedHighlight() {
    if (!data.user) return signIn();
    if (
      socialBusy ||
      !selection ||
      socialVisibility === "private" ||
      !highlightConfirmationCurrent ||
      (socialVisibility === "group" && !activeGroups.some((group) => group.id === socialGroupId)) ||
      (socialVisibility === "member" && !socialMember)
    )
      return;
    setSocialBusy(true);
    try {
      let annotationId = socialAnnotationId;
      if (!annotationId) {
        const saved = await api<any>("/annotations", "POST", {
          bookId: id,
          quote: selection.text,
          cfi: selection.cfi,
          chapter: selection.chapter,
          color,
          note: "",
          progress: position.current.progress,
        });
        annotationId = saved.id;
      }
      const groupId = socialVisibility === "group" ? socialGroupId : null;
      await api(`/social/highlights/${encodeURIComponent(annotationId!)}/share`, "POST", {
        visibility: socialVisibility,
        recipientUserId: socialVisibility === "member" ? socialMember?.id : null,
        groupId,
        shareNote: !!socialAnnotationId && socialShareNote,
        progress: position.current.progress,
        expectedVersion: selectedAudienceShare?.version ?? 0,
        expectedAnnotationVersion: socialShareNote ? socialConfirmedAnnotationVersion : undefined,
        audienceConfirmed: true,
      });
      await reload();
      await socialReader.refetch();
      setSocialCompose(null);
      setSelection(null);
      setSocialAnnotationId(null);
      setSocialShareNote(false);
      toast.success("Highlight shared");
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        setSocialAudienceConfirmed(false);
        if (socialAnnotationId) await selectedShare.refetch();
      }
      toast.error((e as Error).message);
    } finally {
      setSocialBusy(false);
    }
  }
  async function saveSocialPreferences(next: any) {
    if (!data.user) return signIn();
    const p = socialReader.data?.preferences || {
      enabled: false,
      audienceMode: "friends",
      groupId: null,
      showDiscussions: true,
      showHighlights: true,
      showReactions: false,
      density: 35,
      version: 0,
    };
    try {
      await api("/social/reader/preferences", "POST", {
        enabled: p.enabled,
        audienceMode: p.audienceMode,
        groupId: p.groupId,
        showDiscussions: p.showDiscussions,
        showHighlights: p.showHighlights,
        showReactions: p.showReactions,
        density: p.density,
        expectedVersion: p.version,
        ...next,
      });
      await socialReader.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function toggleBookmark(bookmark?: TextBookmark) {
    if (!data.user) return signIn();
    if (previewMode) {
      toast.message(
        "Text bookmarks are available for full editions. Sample position is saved separately.",
      );
      return;
    }
    const productId = bookQuery.data?.productId,
      cfi = position.current.cfi;
    if (!productId || !cfi) return;
    try {
      const client = await ensureSyncClient(data.user.id);
      if (bookmark)
        await api("/bookmarks/" + encodeURIComponent(bookmark.id), "DELETE", {
          expectedVersion: bookmark.version,
          clientId: client.clientId,
        });
      else
        await api("/bookmarks", "POST", {
          productId,
          externalBookId: id,
          cfi,
          chapter: chapter || "",
          label: chapter || `Bookmark at ${percent}%`,
          excerpt: "",
          progress: position.current.progress,
          clientId: client.clientId,
        });
      await reload();
      toast.success(bookmark ? "Bookmark removed" : "Page bookmarked");
    } catch (e) {
      toast.error((e as Error).message);
    }
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
      onPointerMove={(event) => {
        if (event.clientY <= 18 || event.clientY >= window.innerHeight - 18) showChrome();
      }}
    >
      {ready && !chromeVisible && (
        <button
          className="reader-controls-toggle icon-button"
          style={{ background: themes[theme].bg, color: themes[theme].fg }}
          aria-label="Show reader controls"
          onClick={() => showChrome(false)}
        >
          <Menu size={20} />
        </button>
      )}
      <header
        className={"reader-top reader-chrome" + (chromeVisible ? " is-visible" : "")}
        onPointerEnter={() => showChrome(false)}
        onPointerLeave={() => scheduleChromeHide(1800)}
        onFocusCapture={() => showChrome(false)}
        onBlurCapture={() => scheduleChromeHide(1800)}
      >
        <a href={"/book/" + id} className="icon-button" aria-label="Leave reader">
          <ArrowLeft size={20} />
        </a>
        <div className="reader-book-title">
          <strong>{bookQuery.data?.title || "Opening book"}</strong>
          <span>
            {previewMode ? `SAMPLE · ${chapter || "EPUB READER"}` : chapter || "EPUB READER"}
          </span>
        </div>
        <div className="reader-toolbar">
          {!previewMode && (!!editions.data?.results.length || !!syncEdition.current) && (
            <button
              className="icon-button"
              aria-label="Switch to audiobook"
              onClick={async () => {
                const edition =
                  syncEdition.current ||
                  editions.data!.results.find(
                    (e) => e.alignment?.verified && e.epubSha256 === epubHash.current,
                  ) ||
                  editions.data!.results[0];
                await persistPosition();
                if (syncConflict.current) {
                  toast.error("Biosync moved on another device. Reload before switching.");
                  return;
                }
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
          {!previewMode && (
            <button
              className="icon-button"
              title="Text bookmarks"
              aria-label="Text bookmarks"
              onClick={() => setPanel("bookmarks")}
            >
              <Bookmark size={19} />
            </button>
          )}
          <button
            className="icon-button"
            title="Book highlights"
            aria-label="Book highlights"
            onClick={() => setPanel("highlights")}
          >
            <Highlighter size={19} />
          </button>
          {!previewMode && (
            <button
              className={`icon-button ${socialReader.data?.preferences?.enabled ? "social-active" : ""}`}
              title="Social Reading"
              aria-label="Social Reading"
              onClick={() => setPanel("social")}
            >
              <Users size={19} />
            </button>
          )}
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
          aria-label={tr("reader.previousPage", "Previous page")}
          className="reader-page-turn prev"
          disabled={!ready}
          onClick={() => {
            advancedPage.current = true;
            rendition.current?.prev().catch(() => {});
          }}
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
        {!!socialReader.data?.preferences?.enabled && !!passageMarkers.length && (
          <aside className="reader-social-gutter" aria-label="Social reading indicators">
            {passageMarkers.map((marker) => (
              <button
                key={marker.hash}
                style={{ position: "absolute", top: marker.top, right: 0 }}
                onClick={() => {
                  setActiveSocialHash(marker.hash);
                  setPanel("social");
                }}
                title={`${marker.count} contributions at ${marker.chapter}`}
                aria-label={`Open ${marker.count} reader contributions in ${marker.chapter}${marker.passage ? ": " + marker.passage : ""}`}
              >
                <span>•</span>
                <small>{marker.count}</small>
              </button>
            ))}
          </aside>
        )}
        <button
          aria-label={tr("reader.nextPage", "Next page")}
          className="reader-page-turn next"
          disabled={!ready}
          onClick={() => {
            advancedPage.current = true;
            rendition.current?.next().catch(() => {});
          }}
        >
          <ChevronRight size={26} />
        </button>
      </div>
      <footer
        className={"reader-bottom reader-chrome" + (chromeVisible ? " is-visible" : "")}
        onPointerEnter={() => showChrome(false)}
        onPointerLeave={() => scheduleChromeHide(1800)}
        onFocusCapture={() => showChrome(false)}
        onBlurCapture={() => scheduleChromeHide(1800)}
      >
        <span>{ready ? chapter : "Preparing book…"}</span>
        <div>
          <span>{ready ? percent + (previewMode ? "% of sample" : "% read") : ""}</span>
          {data.user ? (
            <button
              className="reader-save-status"
              onClick={() =>
                positionConflict.current ? window.location.reload() : persistPosition()
              }
            >
              {saveState ||
                (previewMode ? "Your sample place will be saved" : "Your place will be saved")}
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
            {!previewMode && (
              <button
                onClick={() => {
                  setSocialCompose("discussion");
                  setSocialBody("");
                  setDiscussionDirect(false);
                  setDiscussionMember(null);
                  setDiscussionVisibility("friends");
                  setDiscussionGroupId("");
                  setDiscussionAudienceConfirmed(false);
                }}
                title="Start a margin discussion"
              >
                <MessageCircle size={17} /> Discuss
              </button>
            )}
            {!previewMode && (
              <button
                disabled={socialBusy}
                onClick={() => void openHighlightSharing()}
                title="Share this highlight"
              >
                <Share2 size={17} /> Share
              </button>
            )}
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
          <div className="annotation-social-actions">
            <a className="text-link" href="/highlights">
              Edit in your notebook <Pencil size={14} />
            </a>
            {!previewMode && (
              <button
                className="text-link"
                disabled={socialBusy}
                onClick={() => void openHighlightSharing(activeAnnotation)}
              >
                <Share2 size={14} /> {tr("reader.shareHighlight", "Share this saved highlight")}
              </button>
            )}
          </div>
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
                ? tr("reader.chapters", "Chapters")
                : panel === "search"
                  ? tr("reader.find", "Find in this book")
                  : panel === "highlights"
                    ? tr("reader.savedPassages", "Your saved passages")
                    : panel === "bookmarks"
                      ? tr("reader.bookmarks", "Your bookmarks")
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
                <button
                  className="button gold"
                  onClick={() => {
                    const exact = data.bookmarks.find(
                      (b) => matchesReadingBook(b.bookId) && b.cfi === position.current.cfi,
                    );
                    toggleBookmark(exact);
                  }}
                >
                  <Bookmark size={16} />{" "}
                  {data.bookmarks.some(
                    (b) => matchesReadingBook(b.bookId) && b.cfi === position.current.cfi,
                  )
                    ? "Remove bookmark here"
                    : "Bookmark current page"}
                </button>
                {data.bookmarks.filter((b) => matchesReadingBook(b.bookId)).length ? (
                  data.bookmarks
                    .filter((b) => matchesReadingBook(b.bookId))
                    .map((b) => (
                      <button key={b.id} onClick={() => go(b.cfi)}>
                        <strong>
                          {b.label || b.chapter || `Bookmark at ${Math.round(b.progress * 100)}%`}
                        </strong>
                        <p className="small muted">
                          {b.chapter || `${Math.round(b.progress * 100)}% read`}
                        </p>
                      </button>
                    ))
                ) : (
                  <p className="muted small">
                    Bookmarks mark a reading location without highlighting text. Add one for any
                    page you want to return to.
                  </p>
                )}
              </div>
            )}
            {panel === "highlights" && (
              <div className="reader-highlights">
                {readerAnnotations.filter((a) => matchesReadingBook(a.bookId)).length ? (
                  readerAnnotations
                    .filter((a) => matchesReadingBook(a.bookId))
                    .map((a) => (
                      <div key={a.id}>
                        <button
                          onClick={() => go(a.cfi)}
                          style={{ borderLeftColor: colors[a.color] }}
                        >
                          <blockquote>{a.quote}</blockquote>
                          {a.note && <p>{a.note}</p>}
                        </button>
                        <button
                          className="text-link"
                          disabled={socialBusy}
                          aria-label={`Share highlight: ${a.quote.slice(0, 70)}`}
                          onClick={() => void openHighlightSharing(a)}
                        >
                          <Share2 size={14} /> Share this saved highlight
                        </button>
                      </div>
                    ))
                ) : (
                  <p className="muted small">
                    Select a passage in the book, then choose Highlight or Note. Your saved passages
                    will appear here.
                  </p>
                )}
                {bookAnnotationPages.hasNextPage && (
                  <button
                    type="button"
                    className="button outline"
                    disabled={bookAnnotationPages.isFetchingNextPage}
                    aria-label="Load older saved passages from this book"
                    onClick={() => void bookAnnotationPages.fetchNextPage()}
                  >
                    {bookAnnotationPages.isFetchingNextPage
                      ? tr("reader.loadingPassages", "Loading passages…")
                      : tr("reader.morePassages", "Load more saved passages")}
                  </button>
                )}
              </div>
            )}
            {panel === "social" && (
              <div className="reader-social-panel">
                {!data.user ? (
                  <div className="empty-state">
                    <Users size={30} />
                    <h3>{tr("reader.social.guestTitle", "Read alongside people you choose.")}</h3>
                    <p>
                      {tr(
                        "reader.social.guestDescription",
                        "Sign in to enable spoiler-aware shared highlights and margin conversations.",
                      )}
                    </p>
                    <button className="button gold" onClick={signIn}>
                      {tr("reader.social.signIn", "Sign in")}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="social-reading-toggle">
                      <div>
                        <strong>{tr("reader.social.heading", "Social Reading")}</strong>
                        <p className="small muted">
                          {tr(
                            "reader.social.description",
                            "Off by default. The book stays clean until you ask for this layer.",
                          )}
                        </p>
                      </div>
                      <input
                        aria-label={tr("reader.social.enable", "Enable Social Reading")}
                        type="checkbox"
                        checked={!!socialReader.data?.preferences?.enabled}
                        onChange={(e) => saveSocialPreferences({ enabled: e.target.checked })}
                      />
                    </div>
                    <label>{tr("reader.social.audience", "Whose activity")}</label>
                    <Select
                      value={socialReader.data?.preferences?.audienceMode || "friends"}
                      onValueChange={(v) =>
                        saveSocialPreferences({
                          audienceMode: v,
                          groupId:
                            v === "group"
                              ? socialReader.data?.preferences?.groupId ||
                                socialAccount.data?.groups?.find(
                                  (g: any) => g.member_status === "active",
                                )?.id ||
                                null
                              : null,
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">One Cove member</SelectItem>
                        <SelectItem value="friends">Friends / mutuals</SelectItem>
                        <SelectItem value="following">People I follow</SelectItem>
                        <SelectItem value="group">Reading group</SelectItem>
                        <SelectItem value="public">Public readers</SelectItem>
                      </SelectContent>
                    </Select>
                    {socialReader.data?.preferences?.audienceMode === "group" && (
                      <>
                        <label>Reading group</label>
                        <Select
                          value={socialReader.data?.preferences?.groupId || ""}
                          onValueChange={(v) => saveSocialPreferences({ groupId: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a group" />
                          </SelectTrigger>
                          <SelectContent>
                            {socialAccount.data?.groups
                              ?.filter((g: any) => g.member_status === "active")
                              .map((g: any) => (
                                <SelectItem value={g.id} key={g.id}>
                                  {g.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </>
                    )}
                    <div className="social-show-options">
                      <label>
                        <input
                          type="checkbox"
                          checked={!!socialReader.data?.preferences?.showDiscussions}
                          onChange={(e) =>
                            saveSocialPreferences({ showDiscussions: e.target.checked })
                          }
                        />{" "}
                        {tr("reader.social.discussions", "Discussions")}
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!socialReader.data?.preferences?.showHighlights}
                          onChange={(e) =>
                            saveSocialPreferences({ showHighlights: e.target.checked })
                          }
                        />{" "}
                        {tr("reader.social.sharedHighlights", "Shared highlights")}
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!socialReader.data?.preferences?.showReactions}
                          onChange={(e) =>
                            saveSocialPreferences({ showReactions: e.target.checked })
                          }
                        />{" "}
                        {tr("reader.social.reactions", "Reactions")}
                      </label>
                    </div>
                    <label>
                      Density{" "}
                      <span>
                        {Number(socialReader.data?.preferences?.density ?? 35) === 0
                          ? "No margin indicators"
                          : Number(socialReader.data?.preferences?.density ?? 35) < 20
                            ? "Quiet"
                            : Number(socialReader.data?.preferences?.density ?? 35) < 67
                              ? "Balanced"
                              : "Lively"}
                      </span>
                    </label>
                    <Slider
                      key={socialReader.data?.preferences?.version || 0}
                      min={0}
                      max={100}
                      step={1}
                      aria-label="Social density"
                      defaultValue={[Number(socialReader.data?.preferences?.density ?? 35)]}
                      onValueCommit={(v) => saveSocialPreferences({ density: v[0] })}
                    />
                    <p className="small muted">
                      🔒 Spoilers use your furthest saved ebook position or verified audio-to-ebook
                      percentage mappings. Audio and BioSync editions without a percentage mapping
                      stay locked. Set density to zero to hide margin indicators. At most three
                      indicators are shown on a screen.
                    </p>
                    {activeSocial && (
                      <section className="margin-conversation-card">
                        <button className="text-link" onClick={() => setActiveSocialHash(null)}>
                          ← All visible activity
                        </button>
                        <h3>
                          {activeSocial.discussionCount || 0} discussions ·{" "}
                          {activeSocial.highlightCount || 0} highlights
                        </h3>
                        {activeSocial.cfi && (
                          <button
                            className="button outline"
                            onClick={() => {
                              void rendition.current
                                ?.display(activeSocial.cfi)
                                .then(() => setPanel(""))
                                .catch(() => toast.error("This passage could not be opened."));
                            }}
                          >
                            Go to this passage
                          </button>
                        )}
                        {activeSocial.posts?.map((p: any) => (
                          <DiscussionThread
                            key={p.id}
                            contextType="margin"
                            contextId={id}
                            postId={p.id}
                            progress={position.current.progress || percent / 100}
                            title="Passage discussion"
                            initialPost={p}
                            initialUpdatedAt={socialReaderQuery.dataUpdatedAt}
                            onChanged={() => {
                              void socialReader.refetch();
                            }}
                          />
                        ))}
                        {activeSocial.highlights?.map((h: any) => (
                          <article key={h.id}>
                            <strong>{h.name || "Reader"} highlighted</strong>
                            <blockquote>“{h.quote}”</blockquote>
                            {h.note && <p>{h.note}</p>}
                          </article>
                        ))}
                      </section>
                    )}
                    {socialReader.isError && (
                      <p role="alert">
                        Could not load activity.{" "}
                        <button onClick={() => socialReader.refetch()}>Retry</button>
                      </p>
                    )}
                    {socialReader.hasNextPage && (
                      <button
                        className="button outline"
                        disabled={socialReader.isFetchingNextPage}
                        onClick={() => socialReader.fetchNextPage()}
                      >
                        Load older passage activity
                      </button>
                    )}
                    {!activeSocial && (
                      <div className="reader-social-summary">
                        <strong>
                          {socialReader.data?.totalVisible || 0} relevant conversations/highlight
                          clusters reached so far
                        </strong>
                        <p className="small muted">
                          Markers appear beside passages on the visible page. Browse all loaded
                          activity here.
                        </p>
                        {socialReader.data?.indicators?.map((x: any) => (
                          <button
                            key={x.passageHash}
                            onClick={() => setActiveSocialHash(x.passageHash)}
                            aria-label={`Open ${(x.discussionCount || 0) + (x.highlightCount || 0)} reader contributions in ${x.chapter || "this chapter"}: ${String(
                              x.posts?.[0]?.passageText || x.highlights?.[0]?.quote || "",
                            )
                              .replace(/\s+/g, " ")
                              .slice(0, 120)}`}
                          >
                            <span>• {(x.discussionCount || 0) + (x.highlightCount || 0)}</span>
                            <strong>{x.chapter || "This passage"}</strong>
                            <span className="reader-passage-preview">
                              {String(
                                x.posts?.[0]?.passageText || x.highlights?.[0]?.quote || "",
                              ).slice(0, 100)}
                            </span>
                            <small>
                              {x.discussionCount || 0} discussions · {x.highlightCount || 0}{" "}
                              highlights
                            </small>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {panel === "settings" && (
              <div className="reading-settings">
                {formatInfo.fixedLayout && (
                  <div className="reader-format-notice" role="status">
                    <strong>Fixed-layout edition</strong>
                    <p className="small muted">
                      The publisher controls page geometry and typography for this edition, so text
                      size, line spacing, typeface, and scrolling overrides are unavailable.
                    </p>
                  </div>
                )}
                {formatInfo.verticalWriting && (
                  <p className="small muted" role="status">
                    Vertical writing is preserved from the publisher EPUB. Keyboard page direction
                    follows the book’s declared reading order.
                  </p>
                )}
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
                  Your reading appearance syncs across your signed-in devices with per-setting
                  conflict protection. Original book styling is kept where compatible with your
                  choices.
                </p>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <Dialog
        open={!!finishedJourney}
        onOpenChange={(v) => {
          if (!v) setFinishedJourney(null);
        }}
      >
        <DialogContent className="fore-dialog finish-journey-dialog">
          <DialogTitle>Finished.</DialogTitle>
          <DialogDescription>{bookQuery.data?.title}</DialogDescription>
          <div className="finish-mark">
            <Check size={30} />
            <strong>{percent}%</strong>
          </div>
          <p>
            Your Reading Journey is ready. Review its audience before sharing your reading/listening
            mix, sessions, highlight and note counts, and timeline.
          </p>
          <p>
            Current audience:{" "}
            <strong>
              {finishedJourneyAudience.data
                ? finishedJourneyAudience.data.visibility === "private"
                  ? "Private"
                  : finishedJourneyAudience.data.visibility === "followers"
                    ? "Followers"
                    : "Public"
                : finishedJourneyAudience.isError
                  ? "Open the journey to review its audience"
                  : "Loading…"}
            </strong>
          </p>
          <div className="journey-share-row">
            <a
              className="button gold"
              href={`/community?journey=${encodeURIComponent(finishedJourney || "")}`}
            >
              View Reading Journey
            </a>
            <button className="button outline" onClick={() => setFinishedJourney(null)}>
              Stay in the book
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={socialCompose === "discussion"}
        onOpenChange={(v) => {
          if (!v) setSocialCompose(null);
        }}
      >
        <DialogContent className="fore-dialog social-compose-dialog">
          <DialogTitle>Start a margin conversation.</DialogTitle>
          <DialogDescription>
            This discussion is attached to the passage and spoiler-gated by reading progress.
          </DialogDescription>
          <blockquote className="editor-quote">{selection?.text}</blockquote>
          <label className="check-row">
            <input
              type="checkbox"
              checked={discussionDirect}
              onChange={(e) => {
                setDiscussionDirect(e.target.checked);
                setDiscussionAudienceConfirmed(false);
                if (e.target.checked) setDiscussionMember(null);
              }}
            />
            Share only with one member
          </label>
          {discussionDirect ? (
            <MemberPicker
              value={discussionMember}
              onChange={(member) => {
                setDiscussionMember(member);
                setDiscussionAudienceConfirmed(false);
              }}
            />
          ) : (
            <>
              <label>
                Publish audience
                <Select
                  value={discussionVisibility}
                  onValueChange={(value: "public" | "followers" | "friends" | "group") => {
                    setDiscussionVisibility(value);
                    setDiscussionAudienceConfirmed(false);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="friends">Friends / mutuals</SelectItem>
                    <SelectItem value="followers">Followers</SelectItem>
                    <SelectItem value="group">Reading group</SelectItem>
                    <SelectItem value="public">Public</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              {discussionVisibility === "group" && (
                <label>
                  Reading group
                  <Select
                    value={discussionGroupId}
                    onValueChange={(value) => {
                      setDiscussionGroupId(value);
                      setDiscussionAudienceConfirmed(false);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a group" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeGroups.map((group) => (
                        <SelectItem value={group.id} key={group.id}>
                          {group.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
              {discussionVisibility === "group" && activeGroups.length === 0 && (
                <p className="small muted">Join a reading group before publishing to a group.</p>
              )}
            </>
          )}
          <p className="small muted" role="status">
            Audience: {discussionAudienceLabel}. This publishing choice is separate from the
            activity you choose to view in Social Reading.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={discussionAudienceConfirmed}
              onChange={(e) => setDiscussionAudienceConfirmed(e.target.checked)}
            />
            I confirm this discussion will be shared with {discussionAudienceLabel}.
          </label>
          <textarea
            className="note-input"
            aria-label="Margin discussion"
            value={socialBody}
            onChange={(e) => setSocialBody(e.target.value)}
            maxLength={12000}
            placeholder="What do you want other readers to notice?"
          />
          <button
            className="button gold"
            disabled={
              socialBusy ||
              !socialBody.trim() ||
              !discussionAudienceConfirmed ||
              (discussionDirect && !discussionMember) ||
              (!discussionDirect &&
                discussionVisibility === "group" &&
                !activeGroups.some((group) => group.id === discussionGroupId))
            }
            onClick={publishSocialDiscussion}
          >
            {socialBusy ? "Posting…" : `Post to ${discussionAudienceLabel}`}
          </button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={socialCompose === "share"}
        onOpenChange={(v) => {
          if (!v) {
            setSocialCompose(null);
            setSocialAnnotationId(null);
            setSocialShareNote(false);
            setSocialAudienceConfirmed(false);
          }
        }}
      >
        <DialogContent className="fore-dialog social-compose-dialog">
          <DialogTitle>Share this highlight.</DialogTitle>
          <a href="/community?tab=sharing">Manage all my shares</a>
          {socialAnnotationId && selectedShare.isPending && (
            <p className="small muted" role="status">
              Checking current audiences…
            </p>
          )}
          {selectedShare.data?.shares.length ? (
            <section className="shared-audience-list">
              <strong>Currently shared with</strong>
              {selectedShare.data.shares.map((share) => {
                const audience =
                  share.visibility === "member"
                    ? `@${share.recipient?.username || "selected member"}`
                    : share.visibility === "group"
                      ? share.groupName || "reading group"
                      : {
                          friends: "friends / mutuals",
                          followers: "followers",
                          public: "the public",
                        }[share.visibility];
                return (
                  <div key={share.id}>
                    <span>
                      {audience} · {share.shareNote ? "note included" : "highlight only"}
                    </span>
                    <button
                      className="text-link"
                      disabled={socialBusy}
                      onClick={async () => {
                        setSocialBusy(true);
                        try {
                          await api(
                            `/social/highlights/${encodeURIComponent(socialAnnotationId!)}/share`,
                            "DELETE",
                            { shareId: share.id, expectedVersion: share.version },
                          );
                          await Promise.all([selectedShare.refetch(), socialReader.refetch()]);
                          toast.success("Audience removed");
                        } catch (e) {
                          toast.error((e as Error).message);
                        } finally {
                          setSocialBusy(false);
                        }
                      }}
                    >
                      Unshare
                    </button>
                  </div>
                );
              })}
            </section>
          ) : socialAnnotationId && selectedShare.isSuccess ? (
            <p className="small muted">This highlight has not been shared yet.</p>
          ) : null}
          <DialogDescription>
            Your saved notes remain private unless you explicitly choose to publish them.
          </DialogDescription>
          <blockquote className="editor-quote">{selection?.text}</blockquote>
          <label>
            Audience
            <Select
              value={socialVisibility}
              onValueChange={(value: ReaderHighlightVisibility) => {
                setSocialVisibility(value);
                setSocialAudienceConfirmed(false);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Keep private — do not publish</SelectItem>
                <SelectItem value="member">One Cove member</SelectItem>
                <SelectItem value="friends">Friends / mutuals</SelectItem>
                <SelectItem value="followers">Followers</SelectItem>
                <SelectItem value="group">Reading group</SelectItem>
                <SelectItem value="public">Public</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {socialVisibility === "member" && (
            <MemberPicker
              value={socialMember}
              onChange={(member) => {
                setSocialMember(member);
                setSocialAudienceConfirmed(false);
              }}
            />
          )}
          {socialVisibility === "group" && (
            <label>
              Reading group
              <Select
                value={socialGroupId}
                onValueChange={(value) => {
                  setSocialGroupId(value);
                  setSocialAudienceConfirmed(false);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a reading group" />
                </SelectTrigger>
                <SelectContent>
                  {activeGroups.map((group) => (
                    <SelectItem value={group.id} key={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          {socialAnnotationId && selectedShare.data?.note && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={socialShareNote}
                onChange={(e) => {
                  setSocialShareNote(e.target.checked);
                  setSocialAudienceConfirmed(false);
                }}
              />{" "}
              Include my private note with this shared highlight
            </label>
          )}
          {socialShareNote && selectedShare.data && (
            <div className="reader-format-notice">
              <strong>Note copy to publish</strong>
              <blockquote>{selectedShare.data.note || "No note text"}</blockquote>
              {socialAudienceConfirmed && !highlightConfirmationCurrent && (
                <p role="alert">Your private note changed. Review this copy and confirm again.</p>
              )}
            </div>
          )}
          {selectedShare.isError && socialAnnotationId && (
            <p role="alert">
              Could not check current audiences.{" "}
              <button onClick={() => selectedShare.refetch()}>Retry sharing status</button>
            </p>
          )}
          <p className="small muted" role="status">
            Audience: {highlightAudienceLabel}.{" "}
            {socialVisibility === "private"
              ? "Choose a publishable audience to share this highlight."
              : "This audience is independent of your Social Reading viewing preferences."}
          </p>
          {socialVisibility !== "private" && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={highlightConfirmationCurrent}
                onChange={(e) => {
                  setSocialAudienceConfirmed(e.target.checked);
                  setSocialConfirmedAnnotationVersion(
                    selectedShare.data?.annotationVersion ?? null,
                  );
                }}
              />
              I confirm this highlight will be shared with {highlightAudienceLabel}
              {socialShareNote ? ", including my current note" : ""}.
            </label>
          )}
          <button
            className="button gold"
            disabled={
              socialBusy ||
              (!!socialAnnotationId &&
                (selectedShare.isPending || selectedShare.isFetching || selectedShare.isError)) ||
              socialVisibility === "private" ||
              !highlightConfirmationCurrent ||
              (socialVisibility === "group" &&
                !activeGroups.some((group) => group.id === socialGroupId)) ||
              (socialVisibility === "member" && !socialMember)
            }
            onClick={shareSelectedHighlight}
          >
            {socialBusy
              ? "Sharing…"
              : socialVisibility === "private"
                ? "Choose an audience"
                : selectedAudienceAlreadyShared
                  ? "Update this audience"
                  : "Share with this audience"}
          </button>
        </DialogContent>
      </Dialog>
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
