/* eslint-disable prettier/prettier -- Module will be normalized when the soundtrack review UI stabilizes. */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Music2, ShieldCheck } from "lucide-react";
import { api } from "./client";
import { useStorefrontLocale } from "./localization";

type Recording = {
  id: string;
  title: string;
  performer: string;
  composer: string;
  period: string;
  instruments: string[];
  moods: string[];
  energy: number | null;
  hasVocals: boolean | null;
  attribution: string;
  sourcePage: string;
  license: string;
  licenseUrl: string;
  audioUrl: string;
  modifications: string;
  durationSeconds?: number;
};
export function SoundtrackLibraryPage() {
  const { rightsCountry } = useStorefrontLocale();
  const [filter, setFilter] = useState("");
  const catalog = useQuery({
    queryKey: ["soundtracks", rightsCountry],
    queryFn: () => api<{ recordings: Recording[]; count: number }>("/soundtracks/recordings"),
    staleTime: 5 * 60_000,
    enabled: typeof window !== "undefined",
    retry: false,
  });
  const recordings = useMemo(
    () => (catalog.data?.recordings || []).filter((r) =>
      [r.title, r.composer, r.performer, r.period, ...r.instruments, ...r.moods]
        .join(" ").toLowerCase().includes(filter.toLowerCase().trim())),
    [catalog.data, filter],
  );
  return (
    <main className="help-page" aria-label="Cove soundtrack recordings">
      <div className="page-eyebrow">COVE SOUNDTRACKS</div>
      <div className="page-heading">
        <div>
          <h1>Rights-reviewed music library</h1>
          <p>Music for reading, with recording-specific source credits and rights information.</p>
        </div>
        <Music2 aria-hidden="true" size={36} />
      </div>
      <p className="small muted">
        Only recordings separately reviewed for the selected storefront territory and securely
        stored by Cove appear here. A public-domain composition alone does not clear a performance.
      </p>
      <label htmlFor="soundtrack-search">Search the music library</label>
      <input id="soundtrack-search" type="search" value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Composer, work, period, mood or instrument" />
      {catalog.isPending ? <p role="status">Checking available recordings…</p> : null}
      {catalog.isError ? <p role="alert">The soundtrack library could not be loaded.</p> : null}
      {catalog.isSuccess && recordings.length === 0 ?
        <p role="status">No rights-reviewed recordings match yet. More music is being reviewed.</p> : null}
      <div className="help-articles">
        {recordings.map((r) => (
          <article key={r.id} className="help-article" aria-label={r.title}>
            <div className="page-eyebrow"><ShieldCheck size={16} aria-hidden="true" /> REVIEWED RECORDING</div>
            <h2>{r.title}</h2>
            <p>{r.composer} · Performed by {r.performer}</p>
            <p className="small muted">
              {[r.period, ...r.instruments, ...r.moods].filter(Boolean).join(" · ")}
              {r.hasVocals === true ? " · Vocals" : r.hasVocals === false ? " · Instrumental" : ""}
            </p>
            <audio controls preload="none" src={r.audioUrl} aria-label={"Play " + r.title}
              onPlay={(event) => {
                // A soundtrack is accompanying music, not a set of simultaneous tracks.
                document.querySelectorAll<HTMLAudioElement>("audio").forEach((other) => {
                  if (other !== event.currentTarget) other.pause();
                });
              }}
            />
            <details>
              <summary>Recording rights and attribution</summary>
              <p>{r.attribution}</p>
              <p>{r.modifications}</p>
              <p><a href={r.audioUrl} download>Download original recording</a></p>
              <p>The original recording remains available under its stated license. Cove adds no restrictions to that license.</p>
              <p>License: <a href={r.licenseUrl} target="_blank" rel="noopener noreferrer">{r.license}</a></p>
              <p><a href={r.sourcePage} target="_blank" rel="noopener noreferrer">View original Wikimedia Commons file and evidence</a></p>
            </details>
          </article>
        ))}
      </div>
      <p className="small muted">
        The canonical book and chapter playlists are a separate feature in development.
        Recordings are never assigned to a book without chapter-specific editorial review.
      </p>
    </main>
  );
}
