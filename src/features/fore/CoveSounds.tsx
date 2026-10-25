/* eslint-disable prettier/prettier -- Initial music discovery UI follows the existing SoundtrackLibrary style until layout normalization. */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Check, Copy, Headphones, Music2, Share2, Sparkles } from "lucide-react";
import { api, authorOf, coverOf, editionPath, useAccount, type CatalogBook } from "./client";
import { useStorefrontLocale } from "./localization";
import { COVE_SOUNDS_STATIONS, stationBySlug, stationRecordings, type CoveSoundsStation, type CoveSoundsRecording } from "./cove-sounds-stations";
import "./cove-sounds.css";

type RecordingCatalog = { recordings: CoveSoundsRecording[]; count: number };
type SearchReply = { results: CatalogBook[] };
type PlaylistReply = { provisional: boolean; reason?: string; playlist: { tracks: { recording: CoveSoundsRecording; reasons: string[] }[] } | null };
type PublicShelf = { id: string; title: string; description: string; item_count: number; likes: number; username?: string; user_id: string };
const labelFor = (station: CoveSoundsStation) => "Cove Sounds: " + station.title;
const canonicalStation = (station: CoveSoundsStation) => "https://cove-puce-theta.vercel.app/sounds/" + station.slug;
const profileMarker = (station: CoveSoundsStation) => "#CoveSounds/" + station.slug;
const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function MusicStationCard({ station }: { station: CoveSoundsStation }) {
  return (
    <a href={"/sounds/" + station.slug} className="sounds-station" style={{ "--sounds-accent": station.accent } as CSSProperties}>
      <span className="sounds-station-symbol" aria-hidden="true"><Music2 size={30} strokeWidth={1.4} /></span>
      <span className="sounds-station-body">
        <span className="sounds-station-eyebrow">{station.atmosphere}</span>
        <strong>{station.title}</strong>
        <span>{station.description}</span>
        <span className="sounds-station-link">Enter this atmosphere <ArrowRight size={16} aria-hidden="true" /></span>
      </span>
    </a>
  );
}

function shareUrl(station: CoveSoundsStation) {
  return typeof window === "undefined" ? canonicalStation(station) : window.location.origin + "/sounds/" + station.slug;
}

/** No copyrighted recording or cover art is embedded in the downloadable card. */
async function shareArtwork(station: CoveSoundsStation, book?: { title: string; recording: string }) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot export artwork.");
  const background = ctx.createLinearGradient(0, 0, 1080, 1350);
  background.addColorStop(0, "#0c1523");
  background.addColorStop(0.65, station.accent);
  background.addColorStop(1, "#111827");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 1080, 1350);
  ctx.fillStyle = "#f0e5d4";
  ctx.font = "600 42px Georgia, serif";
  ctx.fillText("cove.", 75, 105);
  ctx.font = "26px sans-serif";
  ctx.fillStyle = "#f0e5d4";
  ctx.fillText(book ? "MY BOOK SOUNDTRACK" : "STORIES YOU CAN FEEL", 75, 420);
  ctx.font = "bold 76px Georgia, serif";
  ctx.fillStyle = "#fff7ed";
  const words = (book?.title || station.title).split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? line + " " + word : word;
    if (ctx.measureText(next).width > 920 && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  lines.slice(0, 3).forEach((value, i) => ctx.fillText(value, 75, 545 + i * 92));
  ctx.font = "30px sans-serif";
  ctx.fillStyle = "#e7e2dc";
  ctx.fillText(book ? "Soundtracked by: " + book.recording.slice(0, 45) : station.atmosphere, 75, 1005);
  ctx.font = "24px sans-serif";
  ctx.fillText(book ? "A story heard through Cove Sounds" : "Find the story behind the sound", 75, 1150);
  ctx.fillText(canonicalStation(station), 75, 1220);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Artwork export failed.");
  const file = new File([blob], "cove-" + station.slug + ".png", { type: "image/png" });
  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: labelFor(station), text: canonicalStation(station) });
      return "Shared artwork.";
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return "Sharing canceled.";
    }
  }
  const link = document.createElement("a");
  const temporary = URL.createObjectURL(blob);
  link.href = temporary;
  link.download = book ? "cove-book-soundtrack-" + station.slug + ".png" : file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(temporary), 10_000);
  return "Artwork saved. Add the image and link to your post.";
}
function StationShare({ station }: { station: CoveSoundsStation }) {
  const [notice, setNotice] = useState("");
  const url = shareUrl(station);
  const text = "Listening to " + station.title + " on Cove — discover its books.";
  return (
    <div className="sounds-share" aria-label="Share this listening station">
      <button type="button" onClick={() => void navigator.clipboard.writeText(url).then(() => setNotice("Link copied.")).catch(() => setNotice("Copy the address from your browser."))}><Copy size={16} /> Copy link</button>
      <a href={"https://x.com/intent/post?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(url)} target="_blank" rel="noopener noreferrer">Share on X</a>
      <a href={"https://www.reddit.com/submit?url=" + encodeURIComponent(url) + "&title=" + encodeURIComponent(labelFor(station))} target="_blank" rel="noopener noreferrer">Reddit</a>
      <button type="button" onClick={() => void shareArtwork(station).then(setNotice).catch(() => setNotice("Artwork export unavailable."))}><Share2 size={16} /> Share image / Stories</button>
      {notice && <span role="status" className="sounds-share-notice">{notice}</span>}
    </div>
  );
}

function BookSoundtrackPreview({ book, station }: { book: CatalogBook; station: CoveSoundsStation }) {
  const [shareMessage, setShareMessage] = useState("");
  const [expanded, setExpanded] = useState(false);
  const id = String(book.publicProductId || book.productId || book.id);
  const { rightsCountry } = useStorefrontLocale();
  const playlist = useQuery({
    queryKey: ["cove-sounds-book-preview", id, rightsCountry],
    queryFn: ({ signal }) => api<PlaylistReply>("/books/" + encodeURIComponent(id) + "/literary-profile/playlist?mode=atmosphere&vocals=none&progress=0", "GET", undefined, { signal }),
    enabled: expanded && typeof window !== "undefined",
    staleTime: 60_000,
    retry: false,
  });
  const first = playlist.data?.playlist?.tracks?.[0];
  return (
    <div className="sounds-book-preview">
      <button type="button" className="sounds-book-preview-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <Headphones size={15} aria-hidden="true" /> {expanded ? "Hide book-specific match" : "Hear this book's match"}
      </button>
      {expanded && (
        <div className="sounds-book-preview-detail">
          {playlist.isPending ? <p role="status">Checking this book's literary soundtrack…</p> : null}
          {playlist.isError ? <p role="alert">This matching service is unavailable right now.</p> : null}
          {playlist.isSuccess && first ? (
            <>
              <p><strong>{first.recording.title}</strong> · {first.recording.composer}</p>
              <p>{first.reasons.slice(0, 2).join(" · ")}</p>
              <audio controls preload="none" src={first.recording.audioUrl} aria-label={"Book-specific match: " + first.recording.title} onPlay={(event) => { document.querySelectorAll<HTMLAudioElement>("audio").forEach((other) => { if (other !== event.currentTarget) other.pause(); }); }} />
              <button type="button" className="sounds-book-preview-toggle" onClick={() => void shareArtwork(station, { title: book.title, recording: first.recording.title }).then(setShareMessage).catch(() => setShareMessage("Sharing is unavailable."))}><Share2 size={15} aria-hidden="true" /> Share book + soundtrack image</button>
              {shareMessage && <p role="status">{shareMessage}</p>}
              <a href={first.recording.licenseUrl} target="_blank" rel="noopener noreferrer">Recording license and attribution</a>
              <p className="sounds-small">{first.recording.attribution}</p>
            </>
          ) : null}
          {playlist.isSuccess && !first ? <p>Book-aware matching is still being prepared for this edition. The station's approved recordings remain available above.</p> : null}
        </div>
      )}
    </div>
  );
}

function SoundtrackBooks({ station }: { station: CoveSoundsStation }) {
  const { rightsCountry } = useStorefrontLocale();
  const found = useQuery({
    queryKey: ["cove-sounds-editions", station.slug, rightsCountry],
    queryFn: ({ signal }) => Promise.all(station.books.map(async ({ title, author }) => {
      try {
        const response = await api<SearchReply>("/catalog?search=" + encodeURIComponent(title) + "&limit=12&availability=available", "GET", undefined, { signal });
        return response.results.find((book) => normalize(book.title) === normalize(title) && normalize(authorOf(book)).includes(normalize(author))) ?? null;
      } catch {
        return null;
      }
    })),
    enabled: typeof window !== "undefined",
    staleTime: 5 * 60_000,
    retry: false,
  });
  const books = (found.data || []).filter((book): book is CatalogBook => !!book);
  return (
    <section className="sounds-books" aria-labelledby="sounds-books-title">
      <div className="sounds-section-heading">
        <span className="sounds-eyebrow">THE STORIES</span>
        <h2 id="sounds-books-title">Turn the atmosphere into a book.</h2>
        <p>Available editions are verified against the selected storefront market; these editorial pairings aren't automatic recommendations.</p>
      </div>
      {found.isPending && <p role="status">Checking books available in your region…</p>}
      {found.isSuccess && !books.length && <p role="status">The featured editions aren't available in your region yet. Browse the <a href="/store">bookstore</a> instead.</p>}
      <div className="sounds-books-grid">
        {books.map((book) => (
          <article className="sounds-book" key={String(book.publicProductId || book.id)}>
            <a href={editionPath(book)} className="sounds-book-art">
              {coverOf(book) ? <img src={coverOf(book)} alt={"Cover of " + book.title} loading="lazy" /> : <BookOpen size={46} aria-hidden="true" />}
            </a>
            <div>
              <h3><a href={editionPath(book)}>{book.title}</a></h3>
              <p>{authorOf(book)}</p>
              <BookSoundtrackPreview book={book} station={station} />
              <a className="sounds-book-cta" href={editionPath(book)}>Explore this book <ArrowRight size={15} aria-hidden="true" /></a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/** Reuses moderated public social reading lists; creators explicitly publish and manage their own books. */
function CreatorListeningShelves({ station }: { station: CoveSoundsStation }) {
  const { data, signIn } = useAccount();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const publicShelves = useQuery({
    queryKey: ["cove-sounds-public-shelves", station.slug, data.user?.id || "guest"],
    queryFn: () => api<{ lists: PublicShelf[] }>("/social/discover"),
    enabled: typeof window !== "undefined",
    staleTime: 2 * 60_000,
    retry: false,
  });
  const shelves = (publicShelves.data?.lists || []).filter((s) => s.description?.includes(profileMarker(station))).slice(0, 6);
  async function createShelf() {
    if (!data.user) { signIn(); return; }
    setBusy(true); setMessage("");
    try {
      const shelf = await api<{ id: string }>("/social/lists", "POST", {
        title: "My " + station.title + " reading shelf",
        description: "Books I love alongside " + station.title + ". " + profileMarker(station) + " " + canonicalStation(station),
        visibility: "public",
        ranked: true,
        commentsEnabled: true,
      });
      window.location.assign("/community?list=" + encodeURIComponent(shelf.id));
    } catch {
      setMessage("We couldn't create your shelf. Please try again.");
      setBusy(false);
    }
  }
  return (
    <section className="sounds-creators" aria-labelledby="sounds-creators-title">
      <div className="sounds-section-heading">
        <span className="sounds-eyebrow">CURATED BY READERS</span>
        <h2 id="sounds-creators-title">Make the atmosphere your own.</h2>
        <p>Create a public reading shelf connected to this mood. Add books and share the playlist link with friends. Only Cove-approved recordings play here.</p>
      </div>
      <button type="button" className="sounds-create" onClick={() => void createShelf()} disabled={busy}>
        <Sparkles size={17} aria-hidden="true" /> {busy ? "Creating…" : "Create a public listening shelf"}
      </button>
      {message && <p role="alert">{message}</p>}
      {shelves.length > 0 && (
        <div className="sounds-shelves-grid">
          {shelves.map((s) => (
            <a key={s.id} href={"/community?list=" + encodeURIComponent(s.id)} className="sounds-shelf">
              <strong>{s.title}</strong>
              <span>{s.username ? "@" + s.username + " · " : ""}{s.item_count || 0} books · {s.likes || 0} hearts</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function StationDetail({ station }: { station: CoveSoundsStation }) {
  const { rightsCountry } = useStorefrontLocale();
  const [selectedId, setSelectedId] = useState("");
  const player = useRef<HTMLAudioElement>(null);
  const catalog = useQuery({
    queryKey: ["cove-sounds-recordings", rightsCountry],
    queryFn: () => api<RecordingCatalog>("/soundtracks/recordings"),
    enabled: typeof window !== "undefined",
    staleTime: 5 * 60_000,
    retry: false,
  });
  const tracks = useMemo(() => stationRecordings(station, catalog.data?.recordings || []), [station, catalog.data]);
  const selected = tracks.find((track) => track.id === selectedId) || tracks[0];
  useEffect(() => { player.current?.pause(); setSelectedId(""); }, [station.slug, rightsCountry]);
  return (
    <div className="sounds-experience" style={{ "--sounds-accent": station.accent } as CSSProperties}>
      <a href="/sounds" className="sounds-back">← All listening stations</a>
      <header className="sounds-detail-hero">
        <span className="sounds-eyebrow">COVE SOUNDS · LISTENING STATION</span>
        <span className="sounds-detail-glyph" aria-hidden="true"><Music2 size={56} strokeWidth={1.1} /></span>
        <h1>{station.title}</h1>
        <p className="sounds-atmosphere">{station.atmosphere}</p>
        <p>{station.description}</p>
        <StationShare station={station} />
      </header>
      <section className="sounds-listening" aria-labelledby="sounds-listening-title">
        <div className="sounds-section-heading">
          <span className="sounds-eyebrow">FIRST, LISTEN</span>
          <h2 id="sounds-listening-title">What this story world sounds like.</h2>
          <p>Original, rights-reviewed performances. Choose a recording to begin; nothing plays automatically.</p>
        </div>
        {catalog.isPending && <p role="status">Checking recordings licensed for your region…</p>}
        {catalog.isError && <p role="alert">Listening is unavailable right now. <a href="/soundtracks">Visit the soundtrack library</a> to retry.</p>}
        {catalog.isSuccess && !tracks.length && <p role="status">No suitable rights-reviewed recordings are available for this atmosphere in your region yet. Explore the featured books below.</p>}
        {selected && (
          <div className="sounds-player">
            <div className="sounds-player-now">
              <Headphones aria-hidden="true" />
              <div><strong>{selected.title}</strong><span>{selected.composer} · {selected.performer}</span></div>
            </div>
            <audio ref={player} key={selected.id} controls preload="none" src={selected.audioUrl} aria-label={"Play " + selected.title} onPlay={(event) => { document.querySelectorAll<HTMLAudioElement>("audio").forEach((other) => { if (other !== event.currentTarget) other.pause(); }); }} />
            <details><summary>Recording rights and credits</summary><p>{selected.attribution}</p><a href={selected.licenseUrl} rel="noopener noreferrer" target="_blank">{selected.license}</a> · <a href={selected.sourcePage} rel="noopener noreferrer" target="_blank">Source evidence</a></details>
            <div className="sounds-track-list" aria-label="Eligible recordings">
              {tracks.map((track, index) => (
                <button key={track.id} type="button" aria-pressed={track.id === selected.id} onClick={() => setSelectedId(track.id)}><span>{String(index + 1).padStart(2, "0")}</span>{track.title}{selected.id === track.id && <Check size={16} aria-hidden="true" />}</button>
              ))}
            </div>
          </div>
        )}
      </section>
      <SoundtrackBooks station={station} />
      <CreatorListeningShelves station={station} />
      <p className="sounds-disclaimer">The music is optional accompaniment, not narration. Book-specific matches are provisional until Cove's literary analysis has verified them. Available recordings and editions vary by region.</p>
    </div>
  );
}
export function CoveSoundsPage({ slug }: { slug?: string }) {
  const station = slug ? stationBySlug(slug) : null;
  if (slug && !station) return <section className="sounds-experience"><h1>Listening station not found</h1><p><a href="/sounds">Explore the available stations</a></p></section>;
  if (station) return <StationDetail station={station} />;
  return (
    <div className="sounds-experience">
      <header className="sounds-index-hero">
        <span className="sounds-eyebrow"><Headphones size={17} aria-hidden="true" /> INTRODUCING COVE SOUNDS</span>
        <h1>Find a story by how you want to feel.</h1>
        <p>Hear the atmosphere. Discover a world. Find your next book.</p>
        <a className="sounds-index-cta" href={"/sounds/" + COVE_SOUNDS_STATIONS[0].slug}>Explore your first atmosphere <ArrowRight size={18} aria-hidden="true" /></a>
      </header>
      <section aria-labelledby="sounds-stations-title">
        <div className="sounds-section-heading">
          <span className="sounds-eyebrow">CHOOSE A FEELING</span>
          <h2 id="sounds-stations-title">Where do you want to go tonight?</h2>
          <p>Six places to begin. Each station introduces real music from Cove's licensed library and books available in your storefront region.</p>
        </div>
        <div className="sounds-stations-grid">{COVE_SOUNDS_STATIONS.map((s) => <MusicStationCard station={s} key={s.slug} />)}</div>
      </section>
      <div className="sounds-index-outro"><BookOpen size={24} aria-hidden="true" /><p>Prefer to start with a book? <a href="/store">Explore the bookstore</a>. Already reading? <a href="/library">Open your library</a> for chapter-aware soundtrack suggestions.</p></div>
    </div>
  );
}
