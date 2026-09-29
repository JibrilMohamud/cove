import {openBiosync,resolveText,resolveAudio,editionBook} from "./biosync-client";
import {timingSummary} from "./biosync";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Headphones,
  Search,
  Download,
  BookOpen,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
  Link2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useAccount, type CatalogBook } from "./client";
import { type AudioEdition, type Playback, formatTime } from "./domain";
import {
  trackUrl,
  loadEdition,
  saveAudioOffline,
  saveCommercialAudioOffline,
  downloadAudioPackage,
  audioAssetKey,
} from "./audio-client";
import { getRecord, getRecords, removeDownload, putRecord } from "./offline";
import { createActivity } from "./reading-activity";
export const narrationLabel = (e: AudioEdition) =>
  e.narration === "human"
    ? "Human narration"
    : e.narration === "computer"
      ? "Computer narration"
      : "Narration unclassified";
export function AudiobooksPage() {
  const [search, setSearch] = useState(""),
    [q, setQ] = useState(""),
    [kind, setKind] = useState("all"),
    [page, setPage] = useState(1),
    [sort, setSort] = useState("title");
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const r = useQuery<{ results: AudioEdition[]; count: number; pages: number }>({
    queryKey: ["audio-catalog", q, kind, page, sort],
    queryFn: () =>
      api(
        "/audiobooks?" +
          new URLSearchParams({ search: q, narration: kind, page: String(page), sort }),
      ),
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="page-eyebrow">FORE AUDIOBOOKS</span>
          <h1>
            Let the story come to you<span className="gold-text">.</span>
          </h1>
          <p>Commercial and public-domain audiobooks, with narration and rights information clearly marked.</p>
        </div>
        <Headphones className="audio-heading-icon" size={48} />
      </div>
      <div className="catalog-search">
        <Search size={20} />
        <input
          aria-label="Search audiobooks"
          placeholder="Search titles, authors, or narrators…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="collection-toolbar">
        <Tabs
          value={kind}
          onValueChange={(v) => {
            setKind(v);
            setPage(1);
          }}
        >
          <TabsList className="fore-tabs">
            <TabsTrigger value="all">All voices</TabsTrigger>
            <TabsTrigger value="human">Human</TabsTrigger>
            <TabsTrigger value="computer">Computer</TabsTrigger>
          </TabsList>
        </Tabs>
        <Select
          value={sort}
          onValueChange={(v) => {
            setSort(v);
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="Sort audiobooks">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="title">Title A–Z</SelectItem>
            <SelectItem value="new">Recently added</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="small muted">{r.data?.count || 0} audiobook editions · Commercial titles and verified public-domain recordings</p>
      {r.error ? (
        <p className="notice">
          {r.error.message} <button onClick={() => r.refetch()}>Retry</button>
        </p>
      ) : r.isLoading ? (
        <p>Finding recordings…</p>
      ) : r.data?.results.length ? (
        <div className="audio-grid">
          {r.data.results.map((e) => (
            <a href={"/listen/" + e.id} className="audio-card" key={e.id}>
              <div className="audio-cover">
                <Headphones size={36} />
                <span>{e.title}</span>
              </div>
              <div>
                <span className={"voice-badge " + e.narration}>{narrationLabel(e)}</span>
                <h2>{e.title}</h2>
                <p>{e.authors.map((a) => a.name).join(", ")}</p>
                <span className="small muted">
                  {e.narrator || "Narrator not listed"} · {e.tracks.length} tracks{e.commercial&&e.audioPublisher?` · ${e.audioPublisher}`:""}
                </span>
                {e.commercial&&<span className="small muted">{e.hasAccess?"In your library":e.offer?`${new Intl.NumberFormat(undefined,{style:"currency",currency:e.offer.currency}).format(e.offer.amountMinor/100)}`:"Commercial edition"}</span>}
                {e.alignment && (
                  <span className="biosync-badge">
                    <Link2 size={13} />
                    {timingSummary(e)}
                  </span>
                )}
              </div>
            </a>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Headphones />
          <h2>No recordings match yet.</h2>
          <p>Try another voice or search. Availability follows your storefront and each edition’s rights.</p>
          <a
            href="https://www.gutenberg.org/browse/categories/2"
            target="_blank"
            rel="noreferrer"
            className="text-link"
          >
            Explore Gutenberg’s computer-audio catalog
          </a>
        </div>
      )}
      {(r.data?.pages || 0) > 1 && (
        <div className="pagination">
          <button
            className="button outline"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span>
            {page} / {r.data?.pages}
          </span>
          <button
            className="button outline"
            disabled={page === r.data?.pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}
export function AudioDownloads({
  edition,
  book = null,
}: {
  edition: AudioEdition;
  book?: CatalogBook | null;
}) {
  const [busy, setBusy] = useState(""),
    [progress, setProgress] = useState(""),
    abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function run(kind: string) {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(kind);
    try {
      if (kind === "offline") await (edition.commercial?saveCommercialAudioOffline(edition,controller.signal,setProgress):saveAudioOffline(edition, controller.signal, setProgress));
      else if(edition.commercial) throw Error("Commercial audiobooks use device-bound offline licenses and cannot be exported as unrestricted ZIP archives.");
      else await downloadAudioPackage(
          edition,
          kind === "both" ? book : null,
          controller.signal,
          setProgress,
        );
      toast.success(
        kind === "offline" ? "Recording saved for offline listening" : "Your package is ready",
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast.error((e as Error).message);
    } finally {
      setBusy("");
      setProgress("");
    }
  }
  return (
    <div className="audio-downloads">
      <div className="inline-actions">
        <button className="button outline" disabled={!!busy} onClick={() => run("offline")}>
          <Download size={16} />
          Save audio offline
        </button>
        {!edition.commercial&&<button className="button outline" disabled={!!busy} onClick={() => run("audio")}>
          Audio ZIP
        </button>}
        {book && !edition.commercial && (
          <button className="button gold" disabled={!!busy} onClick={() => run("both")}>
            <BookOpen size={16} />
            <Headphones size={16} />
            Download text + audio
          </button>
        )}
      </div>
      {busy && (
        <p role="status" className="small">
          {progress || "Preparing download…"}{" "}
          <button className="text-link" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </p>
      )}
    </div>
  );
}
export function BookAudio({ book }: { book: CatalogBook }) {
  const result = useQuery<{ results: AudioEdition[] }>({
      queryKey: ["book-audio", book.id],
      queryFn: () => api("/audiobooks?bookId=" + book.id),
      enabled: !book.uploaded,
    }),
    [id, setId] = useState("");
  const editions = result.data?.results || [],
    edition = editions.find((e) => e.id === id) || editions[0];
  if (!edition) return null;
  return (
    <section className="book-audio">
      <div className="section-heading">
        <h2>
          <Headphones size={21} />
          Also available to listen
        </h2>
        <span className="voice-badge">{narrationLabel(edition)}</span>
      </div>
      {editions.length > 1 && (
        <Select value={edition.id} onValueChange={setId}>
          <SelectTrigger aria-label="Audiobook edition">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {editions.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.narrator || e.title} · {narrationLabel(e)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <p>
        {edition.narrator || "Narrator not listed"} · {edition.tracks.length} tracks
      </p>
      <a className="button outline" href={"/listen/" + edition.id}>
        <Headphones size={16} />
        Open audiobook
      </a>
      <AudioDownloads edition={edition} book={book} />
      <p className="small muted">
        {edition.alignment
          ? timingSummary(edition) + ". Checked passages support text/audio handoff."
          : "Text and audio can be downloaded together. A verified text-to-audio map is not yet available for this recording."}
      </p>
    </section>
  );
}
export function AudioPlayerPage({ id }: { id: string }) {
  const r = useQuery<AudioEdition>({ queryKey: ["audio", id], queryFn: () => loadEdition(id) });
  if (!r.data)
    return (
      <div className="empty-state">
        <Headphones />
        <h2>{r.error ? "Recording unavailable" : "Opening recording…"}</h2>
        {r.error && <p>{r.error.message}</p>}
      </div>
    );
  return <AudioPlayer key={id} edition={r.data} />;
}
function AudioPlayer({edition:e}:{edition:AudioEdition}){
  if(e.commercial&&!e.hasAccess)return <CommercialAudioPreview edition={e}/>;
  return <EntitledAudioPlayer edition={e}/>;
}
function CommercialAudioPreview({edition:e}:{edition:AudioEdition}){const price=e.offer?new Intl.NumberFormat(undefined,{style:"currency",currency:e.offer.currency}).format(e.offer.amountMinor/100):"See price";return <><a className="text-link" href="/audiobooks">← Audiobooks</a><div className="listening-layout"><div className="listen-art"><Headphones size={55}/><h1>{e.title}</h1><p>{e.authors.map(a=>a.name).join(", ")}</p><span className={"voice-badge "+e.narration}>{narrationLabel(e)}</span></div><section className="player-panel"><span className="page-eyebrow">COMMERCIAL AUDIOBOOK</span><h2>{price}</h2><p>{e.audioPublisher||"Audio publisher"}{e.narrator?` · Narrated by ${e.narrator}`:""}</p>{e.previewAvailable?<><h3>Preview</h3><audio controls preload="metadata" src={`/api/fore/audio/${encodeURIComponent(e.id)}/preview`}/></>:<p className="muted">A preview is not available for this edition.</p>}<a className="button gold" href={e.sourceUrl}><BookOpen size={17}/>View book & purchase options</a><p className="small muted">Full playback is unlocked only by an active purchase or eligible subscription entitlement. Offline copies use renewable device-bound licenses.</p></section></div></>;}
function EntitledAudioPlayer({ edition: e }: { edition: AudioEdition }) {
  const { data, signIn, loading } = useAccount(),
    audio = useRef<HTMLAudioElement>(null),
    [index, setIndex] = useState(0),
    [source, setSource] = useState(""),
    [seconds, setSeconds] = useState(0),
    [duration, setDuration] = useState(0),
    [speed, setSpeed] = useState(1),
    [sleep, setSleep] = useState("off"),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [saveState, setSaveState] = useState(""),
    [conflict, setConflict] = useState(false),
    [playing, setPlaying] = useState(false);
  const track = e.tracks[index],
    sync=useRef<Awaited<ReturnType<typeof openBiosync>>|null>(null),
    conflictFlag=useRef(false),
    version = useRef(0),
    seek = useRef(0),
    resume = useRef(false),
    state = useRef({ trackId: track.id, seconds: 0, speed: 1 }),
    chain = useRef(Promise.resolve()),
    activity = useRef<ReturnType<typeof createActivity> | null>(null);
  state.current = { trackId: track.id, seconds, speed };
  const book = useQuery<CatalogBook>({
    queryKey: ["book", e.bookId],
    queryFn: () => api("/books/" + e.bookId),
    enabled: !!e.bookId,
  });
  async function save() {
    if (!ready || conflict) return;
    const value = { ...state.current };
    const localId = `playback:${data.user?.id || "guest"}:${e.id}`;
    const local = { id: localId, ...value, version: version.current, pending: true };
    await putRecord("assets", local).catch(() => {});
    if(!e.commercial&&e.alignment?.version===2&&sync.current){try{const m=await resolveAudio(e,value.trackId,value.seconds);if(m)await sync.current.save(e,m,"audio");}catch(error){setSaveState((error as Error).message);if((error as any).status===409){conflictFlag.current=true;setConflict(true);audio.current?.pause();return;}}}
    if (!data.user) return;
    setSaveState("Saving…");
    chain.current = chain.current
      .catch(() => {})
      .then(async () => {
        try {
          const p = await api("/audio/" + e.id + "/playback", "PUT", {
            ...value,
            version: version.current,
          });
          version.current = p.version;
          await putRecord("assets", { ...local, version: p.version, pending: false }).catch(
            () => {},
          );
          setSaveState("Position saved");
        } catch (err) {
          setSaveState((err as Error).message);
          if ((err as any).status === 409) {
            conflictFlag.current=true;setConflict(true);
            audio.current?.pause();
          }
        }
      });
    await chain.current;
  }
  useEffect(() => {
    if (loading) return;
    let canceled = false;
    (async () => {
      let p: Playback | null = null;
      const local = await getRecord("assets", `playback:${data.user?.id || "guest"}:${e.id}`).catch(
        () => null,
      );
      if (data.user) {
        try {
          p = await api("/audio/" + e.id + "/playback");
          if (local?.pending && local.version === (p?.version || 0)) p = local;
          else if (local?.pending)
            toast.message("A newer position was saved on another device. Using that bookmark.");
        } catch {
          p = local || null;
          setSaveState("Offline · position is saved on this device");
        }
      } else p = local || null;
      const params = new URLSearchParams(location.search);
      let next = p ? e.tracks.findIndex((t) => t.id === p!.trackId) : 0;
      let at = p?.seconds || 0;
      version.current = p?.version || 0;
      setSpeed(p?.speed || 1);
      if(!e.commercial&&e.bookId){sync.current=await openBiosync(e.bookId,data.user?.id||null);const pos=sync.current.current;if(pos&&pos.edition_id===e.id&&pos.epub_sha256===e.epubSha256&&e.tracks.some(t=>t.id===pos.track_id&&t.sha256===pos.audio_sha256)){next=e.tracks.findIndex(t=>t.id===pos.track_id);at=pos.seconds;}}
      if(!e.commercial&&params.get("fromText")==="1"){const cfi=params.get("cfi"),hash=params.get("hash")||"";const m=cfi?await resolveText(e,cfi,hash):null;if(m){next=e.tracks.findIndex(t=>t.id===m.trackId);at=m.seconds;resume.current=true;toast.message("Biosync: continuing from your text passage");}else toast.message("No checked audio match for this passage. Your listening bookmark is preserved.");}
      if (canceled) return;
      seek.current = at;
      setSeconds(at);
      setIndex(Math.max(0, next));
      setReady(true);
    })().catch((err) => {
      setError((err as Error).message);
      setReady(!data.user);
    });
    return () => {
      canceled = true;
    };
  }, [e.id, data.user?.id, loading]);
  useEffect(() => {
    if (!ready) return;
    let canceled = false,
      blobUrl = "";
    setError("");
    setSource("");
    (async () => {
      const cached = await getRecord("assets", audioAssetKey(e, track)).catch(() => null);
      if (canceled) return;
      if (cached) {
        blobUrl = URL.createObjectURL(cached.blob);
        setSource(blobUrl);
      } else setSource(trackUrl(e.id, track.id));
    })();
    return () => {
      canceled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [track.id, e.id, ready]);
  useEffect(() => {
    if (!ready) return;
    const a = createActivity(e.bookId || e.gutenbergId, data.user?.id || null, "listen");
    activity.current = a;
    return () => {
      a.stop();
      activity.current = null;
    };
  }, [e.id, data.user?.id, ready]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (audio.current && !audio.current.paused) void save();
    }, 15000);
    const hide = () => {
      if (document.visibilityState === "hidden") void save();
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [ready, conflict, data.user?.id]);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed, source]);
  useEffect(() => {
    if (sleep === "off") return;
    const t = setTimeout(
      () => {
        audio.current?.pause();
        setSleep("off");
        toast.message("Sleep timer finished");
      },
      Number(sleep) * 60000,
    );
    return () => clearTimeout(t);
  }, [sleep]);
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: e.title,
      artist: e.narrator || e.authors.map((a) => a.name).join(", "),
      album: track.title,
    });
    const handlers: Record<string, () => void> = {
      play: () => {
        void audio.current?.play();
      },
      pause: () => audio.current?.pause(),
      seekbackward: () => {
        if (audio.current) audio.current.currentTime = Math.max(0, audio.current.currentTime - 15);
      },
      seekforward: () => {
        if (audio.current)
          audio.current.currentTime = Math.min(
            audio.current.duration || 0,
            audio.current.currentTime + 15,
          );
      },
    };
    for (const [name, fn] of Object.entries(handlers))
      try {
        navigator.mediaSession.setActionHandler(name as MediaSessionAction, fn);
      } catch {}
    return () => {
      for (const name of Object.keys(handlers))
        navigator.mediaSession.setActionHandler(name as MediaSessionAction, null);
    };
  }, [e.id, track.title]);
  async function selectTrack(i: number, autoplay = false) {
    if (i < 0 || i >= e.tracks.length) return;
    audio.current?.pause();
    await save();
    seek.current = 0;
    resume.current = autoplay;
    setSeconds(0);
    setIndex(i);
  }
  const readHref = e.bookId
    ? `/read/${e.bookId}?audioEdition=${encodeURIComponent(e.id)}&track=${encodeURIComponent(track.id)}&at=${seconds}`
    : "";
  return (
    <>
      <a className="text-link" href="/audiobooks">
        ← Audiobooks
      </a>
      <div className="listening-layout">
        <div className="listen-art">
          <Headphones size={55} />
          <h1>{e.title}</h1>
          <p>{e.authors.map((a) => a.name).join(", ")}</p>
          <span className={"voice-badge " + e.narration}>{narrationLabel(e)}</span>
        </div>
        <section className="player-panel">
          <span className="page-eyebrow">NOW LISTENING</span>
          <h2>{track.title}</h2>
          <p>{e.narrator || "Narrator not listed"}</p>
          <audio
            ref={audio}
            src={source || undefined}
            controls
            preload="auto"
            onLoadedMetadata={() => {
              if (audio.current) {
                audio.current.currentTime = Math.min(
                  seek.current,
                  audio.current.duration || seek.current,
                );
                audio.current.playbackRate = speed;
                setDuration(audio.current.duration);
                if (resume.current) {
                  resume.current = false;
                  void audio.current.play().catch(() => setError("Press play to continue."));
                }
              }
            }}
            onTimeUpdate={() => {
              if (audio.current) {
                state.current.seconds = audio.current.currentTime;
                setSeconds(audio.current.currentTime);
              }
            }}
            onPlay={() => {
              setPlaying(true);
              activity.current?.setPlaying(true);
            }}
            onPause={() => {
              setPlaying(false);
              activity.current?.setPlaying(false);
              void save();
            }}
            onEnded={() => {
              activity.current?.setPlaying(false);
              if (index < e.tracks.length - 1) void selectTrack(index + 1, true);
            }}
            onError={() => {
              if (source)
                setError("This track could not be loaded. Retry or choose a downloaded track.");
            }}
          />
          <div className="player-controls">
            <button
              className="icon-button"
              disabled={index === 0 || !ready}
              onClick={() => selectTrack(index - 1)}
              aria-label="Previous track"
            >
              <SkipBack size={22} />
            </button>
            <button
              className="icon-button"
              aria-label="Rewind 15 seconds"
              onClick={() => {
                if (audio.current) audio.current.currentTime = Math.max(0, seconds - 15);
              }}
            >
              <RotateCcw size={22} />
              <small>15</small>
            </button>
            <span>
              {formatTime(seconds)} / {Number.isFinite(duration) ? formatTime(duration) : "—"}
            </span>
            <button
              className="icon-button"
              aria-label="Forward 15 seconds"
              onClick={() => {
                if (audio.current) audio.current.currentTime = Math.min(duration, seconds + 15);
              }}
            >
              <RotateCw size={22} />
              <small>15</small>
            </button>
            <button
              className="icon-button"
              disabled={index === e.tracks.length - 1 || !ready}
              onClick={() => selectTrack(index + 1)}
              aria-label="Next track"
            >
              <SkipForward size={22} />
            </button>
          </div>
          <div className="review-options">
            <Select value={String(speed)} onValueChange={(v) => setSpeed(Number(v))}>
              <SelectTrigger aria-label="Playback speed">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((v) => (
                  <SelectItem key={v} value={String(v)}>
                    {v}× speed
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sleep} onValueChange={setSleep}>
              <SelectTrigger aria-label="Sleep timer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Sleep timer off</SelectItem>
                {[5, 15, 30, 45, 60].map((v) => (
                  <SelectItem key={v} value={String(v)}>
                    Stop after {v} minutes
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && (
            <p className="notice">
              {error} <button onClick={() => audio.current?.load()}>Retry</button>
            </p>
          )}
          {conflict && (
            <p className="notice">
              Another device has a newer position.{" "}
              <button onClick={() => location.reload()}>Load latest position</button>
            </p>
          )}
          <p className="small muted" role="status">
            {data.user ? (
              saveState || "Your position saves as you listen."
            ) : (
              <button className="text-link" onClick={signIn}>
                Sign in to sync listening across devices
              </button>
            )}
          </p>
          {e.bookId && (
            <a
              className="button gold"
              href={readHref}
              onClick={async (event) => {
                event.preventDefault();
                audio.current?.pause();
                await save();
                if(conflictFlag.current)return;
                location.href = readHref;
              }}
            >
              <BookOpen size={17} />
              {e.alignment ? "Biosync · switch to text" : "Open text edition"}
            </a>
          )}
          <p className="small muted">
            {e.alignment
              ? timingSummary(e)+". Timing is checked automatically. Introductions and unmatched passages are excluded."
              : "This recording has no verified text alignment yet. Your text and listening bookmarks are kept separately."}
          </p>
          <AudioDownloads edition={e} book={book.data || (e.bookId?editionBook(e):null)} />
          <a className="text-link small" href={e.sourceUrl} target="_blank" rel="noreferrer">
            Recording / edition details
          </a>
        </section>
      </div>
      <section className="track-list">
        <div className="section-heading">
          <h2>Tracks</h2>
          <span className="muted">{e.tracks.length} tracks</span>
        </div>
        {e.tracks.map((t, i) => (
          <div key={t.id} className={index === i ? "active" : ""}>
            <button disabled={!ready} onClick={() => selectTrack(i)}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <strong>{t.title}</strong>
              <span>
                {t.duration ? formatTime(t.duration) : ""}
                {index === i && playing ? " · Playing" : ""}
              </span>
            </button>
            {!e.commercial&&<a href={trackUrl(e.id, t.id)} download aria-label={"Download " + t.title}>
              <Download size={17} />
            </a>}
          </div>
        ))}
      </section>
    </>
  );
}
export function OfflineDownloads() {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => getRecords("downloads").then(setRows);
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="offline-downloads">
      <h2>Saved on this device</h2>
      {rows.length ? (
        rows.map((r) => (
          <div className="offline-item" key={r.id}>
            <div>
              <a href={r.kind === "audio" ? "/listen/" + r.edition.id : "/read/" + r.book.id}>
                {r.title}
              </a>
              <p className="small muted">
                {(r.bytes / 1024 / 1024).toFixed(1)} MB ·{" "}
                {r.complete ? "Available offline" : "Partially downloaded · open to resume"}
              </p>
            </div>
            <button
              className="text-link"
              onClick={() =>
                removeDownload(r.id)
                  .then(load)
                  .catch((e) => toast.error(e.message))
              }
            >
              Remove download
            </button>
          </div>
        ))
      ) : (
        <p className="muted">
          Use “Save offline” on a book or recording. Downloads stay in this browser until you remove
          them or clear site data.
        </p>
      )}
    </section>
  );
}
