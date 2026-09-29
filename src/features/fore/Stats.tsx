import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Clock, BookOpen, Headphones, Download } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { api, useAccount, downloadBlob, bookPath, productPath } from "./client";
import { AccountGuard } from "./Collections";
const duration = (seconds: number) =>
  seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : `${Math.round(seconds / 60)} min`;
function Breakdown({ rows, empty }: { rows: { name: string; count: number }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return rows.length ? (
    <div className="stat-breakdown">
      {rows.map((r) => (
        <div key={r.name}>
          <div>
            <span>{r.name}</span>
            <strong>{r.count}</strong>
          </div>
          <span className="stat-bar">
            <span style={{ width: (r.count / max) * 100 + "%" }} />
          </span>
        </div>
      ))}
    </div>
  ) : (
    <p className="quiet-empty">{empty}</p>
  );
}
export function StatsPage() {
  const { data } = useAccount(),
    [days, setDays] = useState("30"),
    [goal, setGoal] = useState(""),
    [busy, setBusy] = useState(false);
  const result = useQuery<any>({
    queryKey: ["stats", data.user?.id, days],
    queryFn: () => api("/stats?days=" + days),
    enabled: !!data.user,
  });
  const s = result.data,
    t = s?.totals;
  async function exportData() {
    setBusy(true);
    try {
      const all = await api("/export");
      downloadBlob(
        new Blob([JSON.stringify(all, null, 2)], { type: "application/json" }),
        "fore-reading-data.json",
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="page-eyebrow">A READING LIFE, IN NUMBERS</span>
          <h1>
            Your stats<span className="gold-text">.</span>
          </h1>
          <p>Time with books. Words discovered. Places your curiosity takes you.</p>
        </div>
        {data.user && (
          <button className="button outline" disabled={busy} onClick={exportData}>
            <Download size={16} />
            Export my data
          </button>
        )}
      </div>
      <AccountGuard>
        <div className="collection-toolbar">
          <div className="privacy-label">Private · visible only to you</div>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger aria-label="Statistics period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                ["7", "Last 7 days"],
                ["30", "Last 30 days"],
                ["90", "Last 90 days"],
                ["365", "Last 365 days"],
                ["all", "All time"],
              ].map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {result.error ? (
          <p className="notice">
            {result.error.message} <button onClick={() => result.refetch()}>Retry</button>
          </p>
        ) : !s ? (
          <p role="status">Gathering your reading history…</p>
        ) : (
          <>
            <div className="stats-cards">
              {[
                [BookOpen, t.finished, "Books finished"],
                [Clock, duration(t.readSeconds), "Active reading"],
                [Headphones, duration(t.listenSeconds), "Listening time"],
                [BarChart3, t.wpm === null ? "—" : t.wpm, "Estimated words / minute"],
              ].map(([Icon, value, label]: any) => (
                <article key={label}>
                  <Icon size={19} />
                  <strong>{value}</strong>
                  <span>{label}</span>
                </article>
              ))}
            </div>
            <div className="stats-layout">
              <section className="stat-panel">
                <div className="section-heading">
                  <h2>Reading rhythm</h2>
                  <span className="muted small">Daily minutes · UTC</span>
                </div>
                {s.daily.length ? (
                  <div className="daily-chart" aria-label="Daily reading and listening minutes">
                    {s.daily.map((d: any) => {
                      const max = Math.max(
                        1,
                        ...s.daily.map((r: any) => r.read_seconds + r.listen_seconds),
                      );
                      return (
                        <div
                          className="day-column"
                          key={d.date}
                          title={`${d.date}: ${duration(d.read_seconds)} reading, ${duration(d.listen_seconds)} listening`}
                        >
                          <div className="day-bars">
                            <span
                              style={{ height: Math.max(0, (d.listen_seconds / max) * 130) + "px" }}
                              className="listen-bar"
                            />
                            <span
                              style={{ height: Math.max(1, (d.read_seconds / max) * 130) + "px" }}
                            />
                          </div>
                          <span>{d.date.slice(5)}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="quiet-empty">
                    Open a book or play a recording to start your history.
                  </div>
                )}
                <div className="chart-legend">
                  <span>● Reading</span>
                  <span>● Listening</span>
                </div>
                <details className="stats-details">
                  <summary>View daily values</summary>
                  <table>
                    <thead>
                      <tr>
                        <th>Date (UTC)</th>
                        <th>Reading minutes</th>
                        <th>Listening minutes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.daily.map((d: any) => (
                        <tr key={d.date}>
                          <td>{d.date}</td>
                          <td>{(d.read_seconds / 60).toFixed(1)}</td>
                          <td>{(d.listen_seconds / 60).toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </section>
              <section className="stat-panel goal-panel">
                <span className="page-eyebrow">{s.goal.year} READING GOAL</span>
                <h2>
                  {s.goal.finished}
                  <span> / {s.goal.target || "—"}</span>
                </h2>
                <p>
                  {s.goal.target
                    ? `books finished this year · ${Math.round((s.goal.finished / s.goal.target) * 100)}% of your goal`
                    : "Set a goal that leaves room for enjoyment."}
                </p>
                {s.goal.target && (
                  <progress
                    max={s.goal.target}
                    value={s.goal.finished}
                    aria-label="Annual reading goal"
                  />
                )}
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await api("/goals", "PUT", { year: s.goal.year, books: Number(goal) });
                      await result.refetch();
                      toast.success("Reading goal saved");
                    } catch (e) {
                      toast.error((e as Error).message);
                    }
                  }}
                >
                  <label htmlFor="reading-goal">Books this year</label>
                  <div className="inline-actions">
                    <input
                      className="fore-input"
                      id="reading-goal"
                      type="number"
                      min="1"
                      max="1000"
                      required
                      value={goal}
                      placeholder={String(s.goal.target || 12)}
                      onChange={(e) => setGoal(e.target.value)}
                    />
                    <button className="button outline">Set goal</button>
                  </div>
                </form>
              </section>
            </div>
            <div className="stats-cards compact-stats">
              {[
                [duration(t.averageSessionSeconds), "Average session"],
                [t.sessions, "Sessions"],
                [t.averageBookWords?.toLocaleString() || "—", "Average book words"],
                [t.averageReadingLevel?.toFixed(1) || "—", "Estimated US grade level"],
              ].map(([value, label]) => (
                <article key={String(label)}>
                  <strong>{value}</strong>
                  <span>{label}</span>
                </article>
              ))}
            </div>
            <p className="small muted stat-method">
              Pace estimates use visible text and active reading time; hidden pages and idle time
              are excluded. Book length covers {t.measuredBooks} completed editions; grade level
              covers {t.leveledBooks} English editions opened in this reader. Grade level uses an
              approximate Flesch–Kincaid calculation, not a measure of literary quality.
            </p>
            <Tabs defaultValue="vocabulary">
              <TabsList className="fore-tabs stats-tabs">
                <TabsTrigger value="vocabulary">Vocabulary</TabsTrigger>
                <TabsTrigger value="genres">Genres & subjects</TabsTrigger>
                <TabsTrigger value="sessions">Sessions</TabsTrigger>
                <TabsTrigger value="books">Finished books</TabsTrigger>
              </TabsList>
              <TabsContent value="vocabulary">
                <section className="stat-panel">
                  <h2>Words you saved</h2>
                  <p className="small muted">
                    Saved dictionary meanings are a record of words you explored; they don’t prove a
                    word was unfamiliar.
                  </p>
                  {s.vocabulary.length ? (
                    <div className="vocabulary-stats">
                      {s.vocabulary.map((w: any) => (
                        <div key={w.word}>
                          <strong>{w.word}</strong>
                          <span>
                            {w.lookups} saved {w.lookups === 1 ? "meaning" : "meanings"} · {w.books}{" "}
                            {w.books === 1 ? "book" : "books"}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="quiet-empty">
                      Select a word while reading and save a definition to begin.
                    </p>
                  )}
                </section>
              </TabsContent>
              <TabsContent value="genres">
                <div className="stats-layout">
                  <section className="stat-panel">
                    <h2>Genres</h2>
                    <Breakdown rows={s.genres} empty="Genre data appears as you finish books." />
                  </section>
                  <section className="stat-panel">
                    <h2>Subjects & subgenres</h2>
                    <p className="small muted">
                      Based on Gutenberg catalog subjects. A book can appear more than once.
                    </p>
                    <Breakdown rows={s.subgenres} empty="No subject data in this period." />
                  </section>
                </div>
              </TabsContent>
              <TabsContent value="sessions">
                <section className="stat-panel">
                  <h2>Recent sessions</h2>
                  <div className="table-scroll">
                    <table className="stats-table">
                      <thead>
                        <tr>
                          <th>Book</th>
                          <th>Mode</th>
                          <th>Started (UTC)</th>
                          <th>Active time</th>
                          <th>Words</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.sessions.map((r: any) => (
                          <tr key={r.id}>
                            <td>
                              <a href={bookPath(r.bookId)}>{r.title}</a>
                            </td>
                            <td>{r.mode === "read" ? "Reading" : "Listening"}</td>
                            <td>
                              {new Date(r.startedAt).toLocaleString(undefined, { timeZone: "UTC" })}
                            </td>
                            <td>{duration(r.seconds)}</td>
                            <td>{r.mode === "read" ? r.words.toLocaleString() : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!s.sessions.length && <p className="quiet-empty">No sessions yet.</p>}
                </section>
              </TabsContent>
              <TabsContent value="books">
                <section className="stat-panel">
                  <h2>Books finished in this period</h2>
                  {s.completed.map((b: any) => (
                    <div className="stat-book" key={b.id}>
                      <a href={productPath(b.book)}>{b.book.title}</a>
                      <span>
                        {new Date(b.finishedAt).toLocaleDateString()} ·{" "}
                        {b.wordCount
                          ? b.wordCount.toLocaleString() + " words"
                          : "Length not measured yet"}
                      </span>
                    </div>
                  ))}
                  {!s.completed.length && (
                    <p className="quiet-empty">
                      Mark a book finished in your library to add it here.
                    </p>
                  )}
                </section>
              </TabsContent>
            </Tabs>
          </>
        )}
      </AccountGuard>
    </>
  );
}
