import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Music2, SkipForward, X } from "lucide-react";
import { api } from "./client";

type Recording = {
  id: string;
  title: string;
  composer: string;
  performer: string;
  attribution: string;
  license: string;
  licenseUrl: string;
  sourcePage: string;
  audioUrl: string;
  durationSeconds: number;
  fingerprint: string;
};
type PlaylistTrack = { id: string; recording: Recording; reasons: string[] };
type PlaylistReply = {
  productId?: string;
  provisional: boolean;
  reason?: string;
  scope?: { requested: string; effective: string; duration: string };
  readingTime?: { estimatedSeconds: number; lowerBoundOnly: boolean };
  playlist: { tracks: PlaylistTrack[]; completion: string } | null;
  limitations?: string[];
};
type Mode = "focus" | "atmosphere" | "immersion";
type Vocals = "none" | "limited" | "any";
const modes: Mode[] = ["focus", "atmosphere", "immersion"];
const vocalsOptions: Vocals[] = ["none", "limited", "any"];

/** Original, unedited recordings only. Selection never relaxes server-side rights gates. */
export function ReaderSoundtrack({
  bookId,
  spine,
  progress,
  ready,
  expanded,
  onClose,
  registered,
}: {
  bookId: string;
  spine: number | null;
  progress: number;
  ready: boolean;
  expanded: boolean;
  onClose: () => void;
  registered: boolean;
}) {
  const [mode, setMode] = useState<Mode>("atmosphere");
  const [vocals, setVocals] = useState<Vocals>("none");
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [message, setMessage] = useState("");
  const [updating, setUpdating] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const pending = useRef<PlaylistTrack[] | null>(null);
  const resumeAfterBoundary = useRef(false);
  const revision = useRef(0);
  const bucket = Math.min(9, Math.max(0, Math.floor(progress * 10)));
  const query = useQuery({
    queryKey: ["reader-soundtrack-v1", bookId, spine, bucket, mode, vocals],
    queryFn: () => {
      const params = new URLSearchParams({ mode, vocals, progress: String(bucket / 10) });
      if (spine !== null) params.set("spine", String(spine));
      return api<PlaylistReply>(
        "/books/" + encodeURIComponent(bookId) + "/literary-profile/playlist?" + params,
      );
    },
    enabled: ready && (expanded || playing),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const next = query.data?.playlist?.tracks;
    if (!next || !next.length) {
      if (query.data && playing) {
        pending.current = [];
        setUpdating(true);
      }
      return;
    }
    if (playing) {
      pending.current = next;
      setUpdating(true);
    } else {
      pending.current = null;
      setUpdating(false);
      setTracks(next);
      setIndex(0);
    }
    // Query identity changes only when chapter, reading bucket or listening mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);
  useEffect(() => {
    // A different book must never inherit the prior book's licensed tracks.
    revision.current++;
    audio.current?.pause();
    pending.current = null;
    setTracks([]);
    setIndex(0);
    setPlaying(false);
    setMessage("");
  }, [bookId]);
  const current = tracks[index];
  const advance = (autoPlay: boolean) => {
    const next = pending.current;
    if (next !== null) {
      pending.current = null;
      setUpdating(false);
      setTracks(next);
      setIndex(0);
      if (!next.length) {
        setPlaying(false);
        setMessage("No eligible recording is available for the new passage.");
        return;
      }
      resumeAfterBoundary.current = autoPlay;
    } else if (index + 1 < tracks.length) {
      resumeAfterBoundary.current = autoPlay;
      setIndex((n) => n + 1);
    } else {
      setPlaying(false);
      setMessage("Playlist finished. Refresh to check for more matching music.");
    }
  };
  useEffect(() => {
    if (!resumeAfterBoundary.current) return;
    resumeAfterBoundary.current = false;
    const player = audio.current;
    if (player) {
      player.currentTime = 0;
      void player.play().catch(() => {
        setPlaying(false);
        setMessage("Playback was paused by your browser. Use the audio controls to resume.");
      });
    }
  }, [current?.id, current?.recording.fingerprint]);
  const feedback = async (reason: "good_fit" | "poor_fit" | "too_intense") => {
    if (!current || !registered) return;
    try {
      await api("/matching/feedback", "POST", {
        productId: query.data?.productId ?? bookId,
        spine,
        mode,
        recordingId: current.id,
        reason,
      });
      setMessage("Feedback saved privately for your matching preferences.");
      await query.refetch();
    } catch {
      setMessage("Feedback could not be saved. Check your connection and try again.");
    }
  };
  // The player remains mounted when the reading panel is collapsed, so music
  // continues only after the reader has explicitly started playback.
  if (!expanded && !playing) return (
    <audio
      ref={audio}
      preload="none"
      src={current?.recording.audioUrl}
      onEnded={() => advance(true)}
      onError={() => {
        if (current) {
          setMessage("Recording is unavailable. Rechecking the rights-cleared playlist.");
          void query.refetch();
          advance(playing);
        }
      }}
    />
  );
  return (
    <section
      aria-label="Reading soundtrack"
      className="reader-soundtrack"
      style={{
        position: "fixed",
        zIndex: 80,
        right: 12,
        bottom: 74,
        width: "min(410px, calc(100vw - 24px))",
        maxHeight: "min(70vh, 620px)",
        overflowY: "auto",
        padding: 16,
        border: "1px solid #9d8d72",
        borderRadius: 12,
        background: "#f7f2e8",
        color: "#27221c",
        boxShadow: "0 12px 35px #0003",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>
          <Music2 size={18} aria-hidden="true" /> Reading soundtrack
        </h2>
        <button type="button" aria-label="Minimize soundtrack" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {expanded && (
        <>
          <p className="small muted">
            Suggested accompaniment, not narration. Recordings remain unedited and are never
            started automatically.
          </p>
          <label htmlFor="reader-soundtrack-mode">Listening style</label>
          <select
            id="reader-soundtrack-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as Mode)}
          >
            {modes.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
          <label htmlFor="reader-soundtrack-vocals">Vocals</label>
          <select
            id="reader-soundtrack-vocals"
            value={vocals}
            onChange={(event) => setVocals(event.target.value as Vocals)}
          >
            {vocalsOptions.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
          {query.data?.scope && (
            <p className="small muted">
              Based on {query.data.scope.effective === "chapter" ? "this chapter" : "the book"}
              {query.data.scope.effective === "book_fallback" ? " (chapter analysis pending)" : ""}.
              Changes to the reading passage take effect at the next track boundary.
            </p>
          )}
        </>
      )}
      {query.isPending && expanded && <p role="status">Checking suitable music…</p>}
      {query.isError && expanded && (
        <p role="alert">
          The soundtrack cannot be checked right now.
          <button type="button" onClick={() => void query.refetch()}>Retry</button>
        </p>
      )}
      {query.data?.provisional && expanded && (
        <p role="status">A reliable soundtrack is not available yet: {query.data.reason}.</p>
      )}
      {!current && !query.isPending && expanded && !query.data?.provisional && (
        <p role="status">No eligible matching recordings are available for this passage.</p>
      )}
      {current && (
        <>
          <p style={{ margin: "12px 0 6px" }}>
            <strong>{current.recording.title}</strong>
            <span className="small muted">
              {" "}— {current.recording.composer}, performed by {current.recording.performer}
            </span>
          </p>
          <audio
            ref={audio}
            controls
            preload="none"
            src={current.recording.audioUrl}
            aria-label={"Reading soundtrack: " + current.recording.title}
            onPlay={(event) => {
              setPlaying(true);
              setMessage("");
              document.querySelectorAll<HTMLAudioElement>("audio").forEach((other) => {
                if (other !== event.currentTarget) other.pause();
              });
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => advance(true)}
            onError={() => {
              setMessage("This recording is unavailable. Rechecking eligible music.");
              void query.refetch();
              advance(playing);
            }}
            style={{ width: "100%" }}
          />
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span className="small muted" aria-label="Playlist position">
              {index + 1} of {tracks.length}
            </span>
            <button
              type="button"
              aria-label="Skip to next soundtrack recording"
              onClick={() => advance(playing)}
            >
              <SkipForward size={17} aria-hidden="true" /> Next
            </button>
          </div>
          {expanded && (
            <>
              <p className="small muted">{current.reasons.join(" · ")}</p>
              <details>
                <summary>Recording attribution and license</summary>
                <p>{current.recording.attribution}</p>
                <p>Original recording, without modifications.</p>
                <p>
                  License: <a href={current.recording.licenseUrl} target="_blank" rel="noreferrer">
                    {current.recording.license}
                  </a>
                </p>
                <a href={current.recording.sourcePage} target="_blank" rel="noreferrer">
                  Recording source and evidence
                </a>
              </details>
              {registered && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => void feedback("good_fit")}>Good fit</button>
                  <button type="button" onClick={() => void feedback("poor_fit")}>Poor fit</button>
                  <button type="button" onClick={() => void feedback("too_intense")}>
                    Too intense
                  </button>
                </div>
              )}
              {!registered && <p className="small muted">Sign in to save private feedback.</p>}
              <p className="small muted">
                Musical and reading-time estimates are not guarantees. Rights and regional
                eligibility are checked again whenever the original recording is played.
              </p>
            </>
          )}
        </>
      )}
      {updating && <p className="small muted" role="status">New chapter music queued for the next recording.</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
