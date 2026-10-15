import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { SoundtrackDossier } from "./soundtrack-review";

type ReviewRow = {
  id: string;
  title: string;
  status: string;
  source_page_url: string;
  source_sha1: string;
  composer: string;
  performer: string;
  period: string;
  license_statement: string;
  license_url: string;
  dossier_json: string;
  quality_status: string;
  quality_report_json: string;
  review_version: number;
  instruments_json: string;
  moods_json: string;
  has_vocals: number | null;
  energy: number | null;
  last_import_error: string;
};
type Snapshot = {
  records: ReviewRow[];
  counts: { status: string; quality_status: string; count: number }[];
  nextCursor: string | null;
};
const layers = ["composition", "arrangement", "lyrics", "performance", "master"] as const;
const split = (text: string) =>
  text
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
function blankDossier(): SoundtrackDossier {
  const layer = () => ({ basis: "", evidenceUrls: [] as string[] });
  return {
    composition: layer(),
    arrangement: layer(),
    lyrics: layer(),
    performance: layer(),
    master: layer(),
    grantingParty: "",
    recordingDate: "",
    territoryBasis: "",
    streamingBasis: "",
    attributionText: "",
    modificationNotice: "Original source file; no modifications by Cove.",
    reviewMethod: "human",
    complexProvenance: false,
    unresolved: [],
  };
}
function ReviewEditor({ row, refresh }: { row: ReviewRow; refresh: () => Promise<unknown> }) {
  const [dossier, setDossier] = useState<SoundtrackDossier>(() => ({
    ...blankDossier(),
    ...JSON.parse(row.dossier_json),
  }));
  const [composer, setComposer] = useState(row.composer),
    [performer, setPerformer] = useState(row.performer);
  const [period, setPeriod] = useState(row.period),
    [instruments, setInstruments] = useState(JSON.parse(row.instruments_json).join(", "));
  const [moods, setMoods] = useState(JSON.parse(row.moods_json).join(", ")),
    [energy, setEnergy] = useState(row.energy ?? 0.5);
  const [vocals, setVocals] = useState(row.has_vocals === 1),
    [territories, setTerritories] = useState("US");
  const [ticket, setTicket] = useState(""),
    [reason, setReason] = useState("");
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const detail = useQuery({
    queryKey: ["soundtrack-review-history", row.id, row.review_version],
    queryFn: () =>
      api<{
        history: { id: string; event_type: string; principal_id: string; created_at: string }[];
      }>("/admin/soundtracks/recordings/" + row.id),
    retry: false,
  });
  async function submit(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setMessage("");
    try {
      await api("/admin/soundtracks/recordings/" + row.id, "POST", {
        action,
        version: row.review_version,
        reason,
        ...extra,
      });
      setMessage("Saved " + action + ".");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Review could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  function field(key: keyof SoundtrackDossier, label: string) {
    return (
      <label className="block" key={key}>
        {label}
        <textarea
          value={String(dossier[key])}
          onChange={(e) => setDossier({ ...dossier, [key]: e.target.value })}
          rows={3}
        />
      </label>
    );
  }
  return (
    <section aria-label={"Review " + row.title}>
      <h2>{row.title}</h2>
      <p>
        {row.status} · Audio QA: {row.quality_status} · {row.license_statement}
      </p>
      <p>
        <a href={row.source_page_url} target="_blank" rel="noopener noreferrer">
          Open original file, listen, and inspect source history
        </a>
      </p>
      <p>
        <a href={row.license_url} target="_blank" rel="noopener noreferrer">
          Read recording license
        </a>
      </p>
      {row.last_import_error ? <p role="alert">Import issue: {row.last_import_error}</p> : null}
      <fieldset disabled={busy}>
        <legend>Rights dossier</legend>
        {layers.map((layer) => (
          <fieldset key={layer}>
            <legend>{layer}</legend>
            <label>
              Rights basis
              <textarea
                rows={3}
                value={dossier[layer].basis}
                onChange={(e) =>
                  setDossier({ ...dossier, [layer]: { ...dossier[layer], basis: e.target.value } })
                }
              />
            </label>
            <label>
              Evidence links, one per line
              <textarea
                rows={2}
                value={dossier[layer].evidenceUrls.join("\n")}
                onChange={(e) =>
                  setDossier({
                    ...dossier,
                    [layer]: { ...dossier[layer], evidenceUrls: e.target.value.split("\n") },
                  })
                }
              />
            </label>
          </fieldset>
        ))}
        {field("grantingParty", "Who grants the recording rights?")}
        {field("recordingDate", "Recording date and source")}
        {field("territoryBasis", "Territory rights basis")}
        {field("streamingBasis", "Commercial streaming rights basis")}
        {field("attributionText", "Required credit, including copyright notices")}
        {field("modificationNotice", "Changes made to the source recording")}
        <label>
          Review method
          <select
            value={dossier.reviewMethod}
            onChange={(e) =>
              setDossier({
                ...dossier,
                reviewMethod: e.target.value as SoundtrackDossier["reviewMethod"],
              })
            }
          >
            <option value="human">Human review</option>
            <option value="ai_assisted">AI assisted evidence review</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={dossier.complexProvenance}
            onChange={(e) => setDossier({ ...dossier, complexProvenance: e.target.checked })}
          />{" "}
          Complex provenance; requires a second reviewer
        </label>
        <label>
          Unresolved questions, one per line
          <textarea
            value={dossier.unresolved.join("\n")}
            onChange={(e) =>
              setDossier({ ...dossier, unresolved: e.target.value.split("\n").filter(Boolean) })
            }
          />
        </label>
        <button type="button" onClick={() => void submit("draft", { dossier })}>
          Save dossier
        </button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Audio verification</legend>
        <p>
          Upload the measured JSON report produced by the audio QA script for this exact original
          file. This does not record a listening review.
        </p>
        <label>
          Measured audio report
          <input
            type="file"
            accept="application/json,.json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 60000) {
                setMessage("The measured audio report must be under 60 KB.");
                return;
              }
              try {
                const report = JSON.parse(await file.text());
                await submit("quality", { report });
              } catch {
                setMessage("The audio report is not valid JSON.");
              }
            }}
          />
        </label>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Decision</legend>
        <label>
          Composer
          <input value={composer} onChange={(e) => setComposer(e.target.value)} />
        </label>
        <label>
          Actual performer
          <input value={performer} onChange={(e) => setPerformer(e.target.value)} />
        </label>
        <label>
          Period
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="unknown">Select period</option>
            {[
              "medieval",
              "renaissance",
              "baroque",
              "classical",
              "romantic",
              "modern",
              "contemporary",
            ].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Instruments, comma separated
          <input value={instruments} onChange={(e) => setInstruments(e.target.value)} />
        </label>
        <label>
          Moods, comma separated
          <input value={moods} onChange={(e) => setMoods(e.target.value)} />
        </label>
        <label>
          Energy, 0 to 1
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={energy}
            onChange={(e) => setEnergy(Number(e.target.value))}
          />
        </label>
        <label>
          <input type="checkbox" checked={vocals} onChange={(e) => setVocals(e.target.checked)} />{" "}
          Contains vocals
        </label>
        <label>
          Approved country codes, comma separated
          <input value={territories} onChange={(e) => setTerritories(e.target.value)} />
        </label>
        <label>
          Review ticket
          <input value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </label>
        <label>
          Decision rationale
          <textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <p>
          Approval confirms all five rights layers and attribution for these territories. Save the
          dossier and pass audio QA first.
        </p>
        <button
          type="button"
          onClick={() =>
            void submit("approve", {
              reviewer: ticket,
              reviewEvidence: reason,
              composer,
              performer,
              period,
              instruments: split(instruments),
              moods: split(moods),
              energy,
              hasVocals: vocals,
              territories: split(territories),
              compositionRightsConfirmed: true,
              performanceRightsConfirmed: true,
              attributionReviewed: true,
            })
          }
        >
          Approve for import
        </button>{" "}
        <button type="button" onClick={() => void submit("endorse")}>
          Record independent second review
        </button>{" "}
        <button type="button" onClick={() => void submit("reject")}>
          Reject
        </button>{" "}
        <button type="button" onClick={() => void submit("revoke")}>
          Withdraw immediately
        </button>{" "}
        <button type="button" onClick={() => void submit("retry")}>
          Retry failed import
        </button>
      </fieldset>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <details>
        <summary>Immutable review history</summary>
        {detail.isError ? (
          <p>History could not be loaded.</p>
        ) : (
          <ol>
            {detail.data?.history.map((event) => (
              <li key={event.id}>
                {event.created_at} · {event.event_type} · {event.principal_id}
              </li>
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}
export function SoundtrackReviewPage() {
  const cache = useQueryClient();
  const [status, setStatus] = useState("pending_review"),
    [after, setAfter] = useState("");
  const [selected, setSelected] = useState("");
  const query = useQuery({
    queryKey: ["soundtrack-review", status, after],
    queryFn: () =>
      api<Snapshot>(
        "/admin/soundtracks?status=" + status + "&limit=20&after=" + encodeURIComponent(after),
      ),
    retry: false,
  });
  const row = query.data?.records.find((r) => r.id === selected);
  return (
    <main className="help-page">
      <h1>Soundtrack rights review</h1>
      <p>
        Staff access requires the soundtracks.review permission. Credentials stay in your
        authenticated session.
      </p>
      <label>
        Review queue
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setAfter("");
            setSelected("");
          }}
        >
          {[
            "pending_review",
            "approved",
            "importing",
            "ready",
            "import_failed",
            "rejected",
            "revoked",
          ].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      {query.isPending ? <p role="status">Loading review queue…</p> : null}
      {query.isError ? <p role="alert">{query.error.message}</p> : null}
      {query.data ? (
        <p>
          {query.data.counts
            .map((c) => c.status + " (QA " + c.quality_status + "): " + c.count)
            .join(" · ")}
        </p>
      ) : null}
      <ul>
        {query.data?.records.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => setSelected(r.id)}>
              {r.title}
            </button>
          </li>
        ))}
      </ul>
      {after ? (
        <button
          type="button"
          onClick={() => {
            setAfter("");
            setSelected("");
          }}
        >
          First page
        </button>
      ) : null}
      {query.data?.nextCursor ? (
        <button
          type="button"
          onClick={() => {
            setAfter(query.data!.nextCursor!);
            setSelected("");
          }}
        >
          Next page
        </button>
      ) : null}
      {row ? (
        <ReviewEditor
          key={row.id + ":" + row.review_version}
          row={row}
          refresh={() => cache.invalidateQueries({ queryKey: ["soundtrack-review"] })}
        />
      ) : null}
    </main>
  );
}
