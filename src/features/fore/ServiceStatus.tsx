import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { api } from "./client";

type Notice = {
  id: string;
  title: string;
  body: string;
  status: string;
  severity: string;
  components: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};
type Status = {
  at: string;
  checkedAt: string | null;
  stale: boolean;
  overall: string;
  components: Array<{ id: string; label: string; status: string; detail: string }>;
  notices: Notice[];
};
const label = (value: string) =>
  ({
    operational: "Responding normally",
    limited: "Limited availability",
    unknown: "Not confirmed",
    unavailable: "Service unavailable",
    investigating: "Investigating",
    identified: "Cause identified",
    monitoring: "Monitoring recovery",
    resolved: "Resolved",
  })[value] || value;

export function ServiceStatusPage() {
  const status = useQuery<Status>({
    queryKey: ["public-service-status"],
    queryFn: () => api("/service-status"),
    refetchInterval: 60000,
    staleTime: 20000,
    retry: false,
  });
  const evidenceStale =
    !status.data?.checkedAt ||
    !Number.isFinite(Date.parse(status.data.checkedAt)) ||
    Date.now() - Date.parse(status.data.checkedAt) > 15 * 60000;
  const active = (id: string) =>
    status.data?.notices.some(
      (notice) => notice.status !== "resolved" && notice.components.includes(id),
    );
  const currentStatus = (id: string, value: string) =>
    status.isError || (evidenceStale && !active(id)) ? "unknown" : value;
  const shown = status.data?.components.map((component) =>
    currentStatus(component.id, component.status),
  ) || ["unknown"];
  const overall = shown.includes("unavailable")
    ? "unavailable"
    : shown.includes("unknown")
      ? "unknown"
      : shown.includes("limited")
        ? "limited"
        : "operational";
  return (
    <div className="help-page">
      <div className="page-eyebrow">COVE SERVICE STATUS</div>
      <div className="page-heading">
        <div>
          <h1>
            Reading room status<span className="gold-text">.</span>
          </h1>
          <p>Recent backend checks and updates published by Cove support.</p>
        </div>
        <button
          className="button outline"
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
      <section className={`help-panel status-overview ${overall}`} aria-live="polite">
        <Activity aria-hidden="true" />
        <h2>
          {status.isLoading
            ? "Checking status…"
            : overall === "unknown"
              ? "Current status could not be confirmed"
              : label(overall)}
        </h2>
        {status.isError && (
          <p>
            {status.error.message} <a href="/help">Get help</a>
          </p>
        )}
        {status.data?.checkedAt && (
          <p className="muted">
            Background checks last completed{" "}
            <time dateTime={status.data.checkedAt}>
              {new Date(status.data.checkedAt).toLocaleString()}
            </time>
            .
          </p>
        )}
        <p className="muted">
          Checks normally refresh every five minutes. They do not test every device, individual
          title, account provider, or payment method.
        </p>
      </section>
      {status.data && (
        <div className="service-components">
          {status.data.components.map((component) => (
            <article className="help-panel" key={component.id}>
              <div className="help-panel-head">
                <h3>{component.label}</h3>
                <span className={`status-pill ${currentStatus(component.id, component.status)}`}>
                  {label(currentStatus(component.id, component.status))}
                </span>
              </div>
              <p>
                {currentStatus(component.id, component.status) === "unknown"
                  ? "A fresh check is required before availability can be confirmed."
                  : component.detail}
              </p>
            </article>
          ))}
        </div>
      )}
      <section className="help-panel">
        <h2>Service updates</h2>
        {status.data && !status.data.notices.length && (
          <p>
            No service updates have been published. The checks above are the available evidence.
          </p>
        )}
        {status.data?.notices.map((notice) => (
          <article className="service-notice" key={notice.id}>
            <span
              className={`status-pill ${notice.status === "resolved" ? "operational" : notice.severity === "outage" ? "unavailable" : "limited"}`}
            >
              {label(notice.status)}
            </span>
            <h3>{notice.title}</h3>
            <p>{notice.body}</p>
            <time dateTime={notice.updatedAt}>{new Date(notice.updatedAt).toLocaleString()}</time>
          </article>
        ))}
      </section>
      <a className="button outline" href="/help">
        Visit the help center
      </a>
    </div>
  );
}

export function PublicNoticeEditor() {
  const creationKey = useRef("");
  const [editing, setEditing] = useState<Notice | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState("");
  const status = useQuery<Status>({
    queryKey: ["staff-public-service-notices"],
    queryFn: () => api("/admin/operations/public-notices"),
    retry: false,
  });
  return (
    <section className="help-panel">
      <div className="help-panel-head">
        <h2>Public service updates</h2>
        <a href="/status">View public status</a>
        <button
          className="button outline compact"
          disabled={busy || status.isFetching}
          onClick={() => void status.refetch()}
        >
          Refresh updates
        </button>
      </div>
      <p>
        Write a customer-safe update. Internal incident details are never published automatically.
        MFA and operations permissions are required.
      </p>
      {(error || status.error) && (
        <p className="commerce-warning" role="alert">
          {error || status.error?.message}
        </p>
      )}
      {saved && <p role="status">{saved}</p>}
      {status.isLoading ? (
        <p>Loading published updates…</p>
      ) : (
        status.data && (
          <>
            <div className="support-ticket-list">
              {status.data.notices.map((notice) => (
                <button
                  className="support-ticket"
                  key={notice.id}
                  onClick={() => {
                    setEditing(notice);
                    setSaved("");
                    setError("");
                  }}
                >
                  <strong>{notice.title}</strong>
                  <span>
                    {label(notice.status)} · revision {notice.version}
                  </span>
                </button>
              ))}
            </div>
            <form
              key={editing ? `${editing.id}:${editing.version}` : "new"}
              className="fore-form support-create"
              onChange={() => {
                if (!editing) creationKey.current = "";
              }}
              onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget,
                  fields = new FormData(form);
                setBusy(true);
                setError("");
                setSaved("");
                try {
                  await api("/admin/operations/public-notices", "POST", {
                    ...(editing
                      ? { id: editing.id, expectedVersion: editing.version }
                      : { id: (creationKey.current ||= crypto.randomUUID()) }),
                    title: fields.get("title"),
                    body: fields.get("body"),
                    status: fields.get("status"),
                    severity: fields.get("severity"),
                    components: fields.getAll("components"),
                    publish: true,
                  });
                  setEditing(null);
                  creationKey.current = "";
                  form.reset();
                  await status.refetch();
                  setSaved("Service update published.");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <h3>{editing ? "Update published notice" : "New public notice"}</h3>
              <label>
                Title
                <input
                  name="title"
                  required
                  minLength={3}
                  maxLength={180}
                  defaultValue={editing?.title || ""}
                />
              </label>
              <label>
                Customer-visible update
                <textarea
                  name="body"
                  rows={4}
                  required
                  maxLength={3000}
                  defaultValue={editing?.body || ""}
                />
              </label>
              <label>
                State
                <select name="status" defaultValue={editing?.status || "investigating"}>
                  {["investigating", "identified", "monitoring", "resolved"].map((value) => (
                    <option value={value} key={value}>
                      {label(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Impact
                <select name="severity" defaultValue={editing?.severity || "degraded"}>
                  <option value="degraded">Degraded</option>
                  <option value="outage">Outage</option>
                </select>
              </label>
              <fieldset>
                <legend>Affected services</legend>
                {[
                  ["storefront", "Bookstore"],
                  ["downloads", "Downloads"],
                  ["catalog_ingestion", "Catalog updates"],
                  ["biosync", "BioSync"],
                ].map(([id, title]) => (
                  <label className="support-checkbox" key={id}>
                    <input
                      name="components"
                      value={id}
                      type="checkbox"
                      defaultChecked={editing?.components.includes(id)}
                    />{" "}
                    {title}
                  </label>
                ))}
              </fieldset>
              <label className="support-checkbox">
                <input type="checkbox" required /> This text is safe to publish publicly.
              </label>
              <div className="inline-actions">
                <button className="button gold" disabled={busy}>
                  {busy ? "Publishing…" : "Publish service update"}
                </button>
                {editing && (
                  <button type="button" className="button outline" onClick={() => setEditing(null)}>
                    New notice
                  </button>
                )}
              </div>
            </form>
          </>
        )
      )}
    </section>
  );
}
