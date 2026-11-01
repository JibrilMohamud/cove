import { useState } from "react";
import "./official-tournament.css";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Clock3, Plus, Trophy } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, useAccount } from "./client";

type Entry = {
  id: string;
  seed: number;
  productId: string;
  title: string;
  sourceExternalId: string;
};
type Match = {
  id: string;
  round: number;
  slot: number;
  entryAId: string;
  entryBId: string;
  status: "open" | "closed";
  winnerEntryId: string | null;
  aVotes: number;
  bVotes: number;
  myEntryId: string | null;
  closesAt: string;
  closedAt: string | null;
};
type OfficialBracket = {
  id: string;
  title: string;
  status: "live" | "completed" | "cancelled";
  currentRound: number;
  roundsTotal: number;
  roundDeadline: string;
  roundDurationMinutes: number;
  championEntryId: string | null;
  version: number;
  createdAt: string;
  entries: Entry[];
  matches: Match[];
};
const verifiedCovers = new Set(["1260", "1342", "84", "2701", "11", "345", "174", "768", "64317", "98"]);
const roundNames = ["Quarterfinals", "Semifinals", "Final"];

function BookThumb({ book }: { book: Entry | undefined }) {
  if (!book) return <span className="cove-tourney-cover cove-tourney-cover-empty"><BookOpen size={20} /></span>;
  return (
    <span className="cove-tourney-cover">
      {verifiedCovers.has(book.sourceExternalId) ? (
        <img src={"/covers/" + book.sourceExternalId + ".jpg"} alt="" loading="lazy"
          onError={(event) => { event.currentTarget.hidden = true; }} />
      ) : <BookOpen size={20} aria-hidden="true" />}
    </span>
  );
}
function dateLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(t));
}
function roundLabel(tournament: OfficialBracket, round: number): string {
  return round === tournament.roundsTotal ? "Final" :
    round === tournament.roundsTotal - 1 ? "Semifinals" : roundNames[0];
}
function BookChoice({
  book, count, selected, winner, disabled, onClick,
}: {
  book: Entry | undefined;
  count: number;
  selected: boolean;
  winner: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={"cove-tourney-book" + (winner ? " winner" : "")}
      aria-pressed={selected} disabled={disabled || !book} onClick={onClick}>
      <BookThumb book={book} />
      <span className="cove-tourney-book-copy">
        <small>{book ? "SEED " + book.seed : "TBD"}</small>
        <strong>{book?.title || "To be decided"}</strong>
      </span>
      <b>{count}</b>
    </button>
  );
}

export function OfficialTournament() {
  const { data, signIn } = useAccount();
  const [selectedId, setSelectedId] = useState("");
  const [bracketOpen, setBracketOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("The Great Cove Book Showdown");
  const [bookIds, setBookIds] = useState("");
  const [duration, setDuration] = useState(1440);
  const [busy, setBusy] = useState(false);
  const tournaments = useQuery<{ items: OfficialBracket[] }>({
    queryKey: ["official-community-tournaments", data.user?.id],
    queryFn: () => api("/social/tournaments"),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  });
  const all = tournaments.data?.items || [];
  const selected = all.find((item) => item.id === selectedId) || all[0];
  const entries = new Map(selected?.entries.map((entry) => [entry.id, entry]) || []);
  const liveMatches = selected?.matches.filter((match) =>
    match.round === selected.currentRound) || [];

  async function cast(match: Match, entryId: string) {
    if (!data.user) return signIn();
    if (busy || !selected) return;
    setBusy(true);
    try {
      await api("/social/tournaments/" + encodeURIComponent(selected.id) + "/vote", "POST", {
        matchId: match.id, entryId,
      });
      await tournaments.refetch();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function advance() {
    if (busy || !selected) return;
    setBusy(true);
    try {
      const result = await api<{ advanced: boolean }>(
        "/social/tournaments/" + encodeURIComponent(selected.id) + "/advance", "POST", {},
      );
      await tournaments.refetch();
      toast.success(result.advanced ? "Round finalized and bracket advanced" : "Round not ready to close");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    if (!data.user) return signIn();
    const ids = bookIds.split(/[\n,]/).map((value) =>
      value.trim().replace(/^.*\/books\//, "").replace(/[?#].*$/, "")).filter(Boolean);
    if (ids.length !== 4 || new Set(ids).size !== 4)
      return toast.error("Enter four different Cove book IDs, one per line.");
    if (busy) return;
    setBusy(true);
    try {
      const result = await api<OfficialBracket>("/social/tournaments", "POST", {
        title: title.trim(), productIds: ids, roundDurationMinutes: duration,
      });
      setSelectedId(result.id);
      setCreateOpen(false);
      setBookIds("");
      await tournaments.refetch();
      toast.success("Your official tournament bracket is live");
      setBracketOpen(true);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const expired = selected && Date.parse(selected.roundDeadline) <= Date.now();
  const active = selected?.status === "live" && !expired;
  const champion = selected?.championEntryId ? entries.get(selected.championEntryId) : null;

  return (
    <section className="cove-tourney-official" aria-labelledby="cove-official-heading">
      <div className="cove-arena-rail-head">
        <h2 id="cove-official-heading"><Trophy size={18} /> LIVE TOURNAMENTS</h2>
        <button type="button" onClick={() => setBracketOpen(true)} disabled={!selected}>
          VIEW BRACKET <ArrowRight size={14} />
        </button>
      </div>
      {tournaments.isLoading && <p className="cove-tourney-message" role="status">Loading official brackets…</p>}
      {tournaments.isError && (
        <div className="cove-tourney-message" role="alert">
          Tournament service is unavailable. The database migration may still be pending.
          <button onClick={() => tournaments.refetch()}>Retry</button>
        </div>
      )}
      {selected && (
        <>
          {all.length > 1 && (
            <label className="cove-tourney-select">Browse tournament
              <select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
                {all.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
          )}
          <div className="cove-tourney-title">
            <span>READERS' CHOICE / {selected.status === "live" ? roundLabel(selected, selected.currentRound) : "Champion crowned"}</span>
            <h3>{selected.title}</h3>
          </div>
          {selected.status === "completed" && champion ? (
            <div className="cove-tourney-champion">
              <Trophy size={25} />
              <span>TOURNAMENT CHAMPION</span>
              <strong>{champion.title}</strong>
            </div>
          ) : (
            <>
              <div className="cove-tourney-preview-matches">
                {liveMatches.map((match) => (
                  <div className="cove-tourney-preview-match" key={match.id}>
                    <div className="cove-tourney-versus-title">MATCH {match.slot} / {match.aVotes + match.bVotes} votes</div>
                    <BookChoice book={entries.get(match.entryAId)} count={match.aVotes}
                      selected={match.myEntryId === match.entryAId}
                      winner={match.winnerEntryId === match.entryAId}
                      disabled={!active || !!busy} onClick={() => cast(match, match.entryAId)} />
                    <BookChoice book={entries.get(match.entryBId)} count={match.bVotes}
                      selected={match.myEntryId === match.entryBId}
                      winner={match.winnerEntryId === match.entryBId}
                      disabled={!active || !!busy} onClick={() => cast(match, match.entryBId)} />
                  </div>
                ))}
              </div>
              <div className="cove-tourney-deadline"><Clock3 size={14} />
                {active ? "Voting closes " + dateLabel(selected.roundDeadline)
                  : "Voting closed " + dateLabel(selected.roundDeadline)}
              </div>
              {expired && (
                <button type="button" className="cove-arena-rail-cta" disabled={busy} onClick={advance}>
                  Finalize round <ArrowRight size={14} />
                </button>
              )}
            </>
          )}
          <div className="cove-tourney-activity">
            <h4>ROUND ACTIVITY</h4>
            <p>{selected.status === "completed" ? "Verified final result · bracket completed" :
              "Round " + selected.currentRound + " of " + selected.roundsTotal + " · " +
              liveMatches.reduce((sum, match) => sum + match.aVotes + match.bVotes, 0) +
              " recorded votes"}</p>
            <p>Results are finalized after the deadline. Ties advance the lower seed.</p>
          </div>
        </>
      )}
      {!selected && !tournaments.isLoading && !tournaments.isError && (
        <div className="cove-tourney-message">
          <BookOpen size={29} />
          <p>No live brackets yet. Launch Cove's first four-book tournament.</p>
        </div>
      )}
      <button type="button" className="cove-tourney-create-button" onClick={() => {
        if (!data.user) return signIn();
        setCreateOpen(true);
      }}><Plus size={16} /> Create a book tournament</button>
      <Dialog open={bracketOpen} onOpenChange={setBracketOpen}>
        <DialogContent className="cove-arena-bracket-dialog cove-tourney-dialog">
          <DialogTitle><Trophy size={20} /> {selected?.title || "Official tournament bracket"}</DialogTitle>
          <DialogDescription>
            Real reader ballots determine each winner. Votes freeze at each round's deadline;
            the final tallies and qualifying books are persisted together.
            Tied matches use the lower original seed.
          </DialogDescription>
          {selected && (
            <div className="cove-tourney-bracket-board">
              {Array.from({ length: selected.roundsTotal }, (_, roundIndex) => {
                const round = roundIndex + 1;
                const matches = selected.matches.filter((match) => match.round === round);
                return (
                  <section key={round} className="cove-tourney-round">
                    <h3>{roundLabel(selected, round)}</h3>
                    {matches.length ? matches.map((match) => (
                      <div className="cove-tourney-bracket-match" key={match.id}>
                        <small>Match {match.slot} · {match.status === "closed" ? "Final" : "Voting"}</small>
                        <BookChoice book={entries.get(match.entryAId)} count={match.aVotes}
                          selected={match.myEntryId === match.entryAId}
                          winner={match.winnerEntryId === match.entryAId}
                          disabled={busy || selected.status !== "live" || round !== selected.currentRound || !!expired}
                          onClick={() => cast(match, match.entryAId)} />
                        <BookChoice book={entries.get(match.entryBId)} count={match.bVotes}
                          selected={match.myEntryId === match.entryBId}
                          winner={match.winnerEntryId === match.entryBId}
                          disabled={busy || selected.status !== "live" || round !== selected.currentRound || !!expired}
                          onClick={() => cast(match, match.entryBId)} />
                      </div>
                    )) : <div className="cove-tourney-awaiting">Awaiting qualifying books</div>}
                  </section>
                );
              })}
              {champion && <div className="cove-tourney-champion"><Trophy size={23} />
                <span>CHAMPION</span><strong>{champion.title}</strong></div>}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="cove-arena-bracket-dialog cove-tourney-dialog">
          <DialogTitle>Host an official tournament</DialogTitle>
          <DialogDescription>
            Choose four existing Cove books. The bracket is fixed at creation; readers vote in
            two timed rounds. Vote totals are finalized on the server, not by the host.
          </DialogDescription>
          <div className="cove-tourney-form">
            <label>Bracket name
              <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>Four Cove book IDs or /books/ links (one per line)
              <textarea value={bookIds} rows={5} onChange={(e) => setBookIds(e.target.value)}
                placeholder={"1342\n1260\n84\n2701"} />
            </label>
            <label>Time per round
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                <option value={60}>1 hour</option>
                <option value={1440}>1 day</option>
                <option value={10080}>1 week</option>
              </select>
            </label>
            <p>A public reader profile and public activity are required. Match ballots are private.</p>
            <button type="button" className="cove-arena-rail-cta" disabled={busy || title.trim().length < 4}
              onClick={create}>{busy ? "Creating…" : "Publish official bracket"}</button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
