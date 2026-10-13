import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LifeBuoy, Search, ArrowLeft, MessageSquare, RefreshCw } from "lucide-react";
import { api, useAccount } from "./client";

type Ticket = {
  id: string;
  subject: string;
  category: string;
  status: string;
  version: number;
  orderId: string | null;
  updatedAt: string;
  createdAt: string;
  requestId?: string | null;
  unread?: boolean;
  userId?: string;
};
type Message = { id: string; sender: "customer" | "staff"; body: string; createdAt: string };
type Thread = { ticket: Ticket; messages: Message[]; nextBefore: string | null };
type Inbox = { tickets: Ticket[]; nextCursor: string | null };
const statusLabel = (value: string) =>
  ({
    open: "Awaiting support",
    pending_customer: "Your reply needed",
    pending_internal: "Under review",
    resolved: "Resolved",
    closed: "Closed",
  })[value] || value;
const categories = ["account", "reading", "download", "billing", "refund", "other"];
const articles = [
  {
    title: "A purchased book is missing",
    text: "Check Orders for payment and delivery status, then your Library. If the order completed and the book is missing, open a support request from that order so support can investigate the correct purchase.",
    href: "/orders",
    link: "Open Orders",
  },
  {
    title: "Request help with a charge or refund",
    text: "Select the order and choose Get help with this order. Include what happened and whether you can access the book. Submitting a request does not issue a refund or make another payment; support reviews it first.",
    href: "/orders",
    link: "Find your order",
  },
  {
    title: "Download and read offline",
    text: "Use Downloads to get an available EPUB and manage reading-data exports. Downloaded EPUBs can be opened in a compatible reader. Online account services and cross-device sync require a connection, and some editions have license restrictions.",
    href: "/downloads",
    link: "Open Downloads",
  },
  {
    title: "BioSync is unavailable for a recording",
    text: "BioSync is available only when timing has been verified for the exact ebook and recording. You can still listen normally when a timing map is unavailable. Different narrations or ebook editions cannot share the same map.",
    href: "/audiobooks",
    link: "Browse audiobooks",
  },
  {
    title: "A title is unavailable in my country",
    text: "Book and format availability can vary by storefront and publisher permissions. Check the edition and storefront selected on Cove. If an existing purchase will not open, contact support with its order reference.",
    href: "/library",
    link: "Open your Library",
  },
  {
    title: "Export data or manage account security",
    text: "Your profile includes account security, session controls, data export, and deletion-request tools. Exported support conversations include customer-visible replies; confidential staff notes are separate.",
    href: "/profile",
    link: "Account settings",
  },
];

export function HelpPage() {
  const [search, setSearch] = useState("");
  const matches = articles.filter((article) =>
    `${article.title} ${article.text}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="help-page">
      <div className="page-eyebrow">COVE SUPPORT</div>
      <div className="page-heading">
        <div>
          <h1>
            How can we help<span className="gold-text">?</span>
          </h1>
          <p>Find an answer or keep a private conversation with Cove support.</p>
        </div>
        <a className="button outline" href="/status">
          Service status
        </a>
      </div>
      <label className="catalog-search">
        <Search aria-hidden="true" />
        <span className="sr-only">Search help articles</span>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search accounts, downloads, orders…"
        />
      </label>
      <div className="help-articles">
        {matches.map((article) => (
          <details className="help-article" key={article.title}>
            <summary>{article.title}</summary>
            <p>{article.text}</p>
            <a className="text-link" href={article.href}>
              {article.link}
            </a>
          </details>
        ))}
        {!matches.length && <p role="status">No matching article. You can ask support below.</p>}
      </div>
      <SupportWorkspace />
      <p className="muted">
        Can’t sign in? <a href="/privacy#contact-us">Use the contact form</a>. Do not send
        passwords, payment-card numbers, or authentication codes.
      </p>
    </div>
  );
}

export function SupportWorkspace({ staff = false }: { staff?: boolean }) {
  const { data } = useAccount();
  return <SupportWorkspaceContent key={`${staff}:${data.user?.id || "guest"}`} staff={staff} />;
}

function SupportWorkspaceContent({ staff = false }: { staff?: boolean }) {
  const { data, signIn, loading } = useAccount();
  const qc = useQueryClient();
  const prefix = staff ? "/admin/support/tickets" : "/support/tickets";
  const identity = ["support-inbox", staff, data.user?.id];
  const [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [orderId, setOrderId] = useState(""),
    [requestId, setRequestId] = useState(""),
    [older, setOlder] = useState<Message[]>([]),
    [olderCursor, setOlderCursor] = useState<string | null | undefined>(),
    [more, setMore] = useState<Ticket[]>([]),
    [listCursor, setListCursor] = useState<string | null | undefined>();
  const createKey = useRef(""),
    replyKey = useRef("");
  const inbox = useQuery<Inbox>({
    queryKey: identity,
    queryFn: () => api(prefix),
    enabled: Boolean(data.user),
    retry: false,
    refetchInterval: 60000,
  });
  const thread = useQuery<Thread>({
    queryKey: ["support-thread", staff, data.user?.id, selected],
    queryFn: () => api(`${prefix}/${selected}`),
    enabled: Boolean(data.user && selected),
    retry: false,
    refetchInterval: 30000,
  });
  useEffect(() => {
    if (staff) return;
    const params = new URLSearchParams(location.search);
    setOrderId(params.get("order") || "");
    setRequestId(params.get("reference") || "");
    const ticket = params.get("ticket");
    if (ticket && /^help_[a-f0-9-]{36}$/.test(ticket)) setSelected(ticket);
  }, [staff]);
  useEffect(() => {
    if (!staff && selected && thread.data?.ticket.version) {
      void api(`${prefix}/${selected}/read`, "POST", { viewedVersion: thread.data.ticket.version })
        .then(() => qc.invalidateQueries({ queryKey: ["support-inbox", false, data.user?.id] }))
        .catch(() => {});
    }
  }, [staff, selected, thread.data?.ticket.version, data.user?.id, prefix, qc]);
  function open(id: string | null) {
    setSelected(id);
    setOlder([]);
    setOlderCursor(undefined);
    setError("");
    replyKey.current = "";
  }
  const refresh = async () => {
    await Promise.all([inbox.refetch(), ...(selected ? [thread.refetch()] : [])]);
  };
  if (loading) return <p role="status">Loading your support inbox…</p>;
  if (!data.user)
    return (
      <section className="help-panel">
        <LifeBuoy aria-hidden="true" />
        <h2>Your support inbox</h2>
        <p>Sign in to open a private request and view replies.</p>
        <button className="button gold" onClick={signIn}>
          Sign in
        </button>
      </section>
    );
  const current = thread.data;
  const messages = [
    ...new Map(
      [...older, ...(current?.messages || [])].map((message) => [message.id, message]),
    ).values(),
  ];
  const tickets = [
    ...(inbox.data?.tickets || []),
    ...more.filter((ticket) => !inbox.data?.tickets.some((item) => item.id === ticket.id)),
  ];
  const failure = error || (selected ? thread.error?.message : inbox.error?.message);
  return (
    <section className="help-panel">
      <div className="help-panel-head">
        <h2>{staff ? "Customer requests" : "Your support inbox"}</h2>
        <button className="button outline compact" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      {failure && (
        <div className="commerce-banner warning" role="alert">
          <p>{failure}</p>
          <button className="text-link" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}
      {selected ? (
        <>
          <button className="text-link" onClick={() => open(null)}>
            <ArrowLeft size={15} /> Back to requests
          </button>
          {thread.isLoading && <p role="status">Loading the conversation…</p>}
          {current && (
            <>
              <h3>{current.ticket.subject}</h3>
              <p className="muted">
                {statusLabel(current.ticket.status)} · Reference {current.ticket.id}
                {current.ticket.orderId && (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={`${staff ? "/staff/support?q=" : "/orders?order="}${encodeURIComponent(current.ticket.orderId)}`}
                    >
                      View order context
                    </a>
                  </>
                )}
              </p>
              {current.ticket.requestId && (
                <p className="muted">Error reference: {current.ticket.requestId}</p>
              )}
              {(olderCursor === undefined ? current.nextBefore : olderCursor) && (
                <button
                  className="button outline compact"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const page = await api<Thread>(
                        `${prefix}/${selected}?before=${encodeURIComponent(olderCursor || current.nextBefore || "")}`,
                      );
                      setOlder((items) => [...page.messages, ...items]);
                      setOlderCursor(page.nextBefore);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Earlier messages
                </button>
              )}
              <ol className="support-conversation" aria-label="Conversation">
                {messages.map((message) => (
                  <li className={`support-message ${message.sender}`} key={message.id}>
                    <div>
                      <strong>
                        {message.sender === "staff" ? "Cove support" : staff ? "Customer" : "You"}
                      </strong>
                      <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleString()}
                      </time>
                    </div>
                    <p>{message.body}</p>
                  </li>
                ))}
              </ol>
              {staff || current.ticket.status !== "closed" ? (
                <form
                  className="fore-form"
                  onChange={() => {
                    replyKey.current = "";
                  }}
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const form = event.currentTarget,
                      fields = new FormData(form);
                    replyKey.current ||= crypto.randomUUID();
                    setBusy(true);
                    setError("");
                    try {
                      const saved = await api<Thread>(`${prefix}/${selected}`, "POST", {
                        requestKey: replyKey.current,
                        expectedVersion: current.ticket.version,
                        message: fields.get("message"),
                        ...(staff ? { status: fields.get("status") } : {}),
                      });
                      qc.setQueryData(["support-thread", staff, data.user?.id, selected], saved);
                      form.reset();
                      replyKey.current = "";
                      await inbox.refetch();
                    } catch (e) {
                      setError((e as Error).message);
                      await thread.refetch();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <label>
                    {staff ? "Reply visible to the customer" : "Your reply"}
                    <textarea name="message" required maxLength={6000} rows={4} />
                  </label>
                  {staff && (
                    <label>
                      Request status
                      <select name="status" defaultValue="pending_customer">
                        <option value="pending_customer">Customer reply needed</option>
                        <option value="pending_internal">Under review</option>
                        <option value="resolved">Resolved</option>
                        <option value="closed">Closed</option>
                        <option value="open">Awaiting support</option>
                      </select>
                    </label>
                  )}
                  <button className="button gold" disabled={busy}>
                    Send reply
                  </button>
                </form>
              ) : (
                <p>This request is closed. Open a new request below if you still need help.</p>
              )}
            </>
          )}
        </>
      ) : (
        <>
          {inbox.isLoading && <p role="status">Loading requests…</p>}
          {!inbox.isLoading && !inbox.error && !tickets.length && (
            <p className="muted">No support requests yet.</p>
          )}
          <div className="support-ticket-list">
            {tickets.map((ticket) => (
              <button className="support-ticket" key={ticket.id} onClick={() => open(ticket.id)}>
                <span>
                  <strong>{ticket.subject}</strong>
                  {ticket.unread && (
                    <span className="support-unread">
                      {staff ? "Unread by customer" : "New reply"}
                    </span>
                  )}
                </span>
                <span>
                  {statusLabel(ticket.status)} · {new Date(ticket.updatedAt).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
          {(listCursor === undefined ? inbox.data?.nextCursor : listCursor) && (
            <button
              className="button outline compact"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const page = await api<Inbox>(
                    `${prefix}?cursor=${encodeURIComponent(listCursor || inbox.data?.nextCursor || "")}`,
                  );
                  setMore((items) => [...items, ...page.tickets]);
                  setListCursor(page.nextCursor);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              More requests
            </button>
          )}
        </>
      )}
      {!staff && (!selected || current?.ticket.status === "closed") && (
        <form
          className="fore-form support-create"
          onChange={() => {
            createKey.current = "";
          }}
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget,
              fields = new FormData(form);
            createKey.current ||= crypto.randomUUID();
            setBusy(true);
            setError("");
            try {
              const saved = await api<Thread>(prefix, "POST", {
                requestKey: createKey.current,
                category: fields.get("category"),
                subject: fields.get("subject"),
                message: fields.get("message"),
                orderId: orderId.trim() || null,
                ...(requestId ? { requestId } : {}),
              });
              form.reset();
              createKey.current = "";
              open(saved.ticket.id);
              qc.setQueryData(["support-thread", false, data.user?.id, saved.ticket.id], saved);
              await inbox.refetch();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3>Open a request</h3>
          <p className="muted">
            Replies appear in this inbox. Please leave out passwords, card numbers, and
            authentication codes.
          </p>
          <label>
            What do you need help with?
            <select name="category" defaultValue={orderId ? "billing" : "other"}>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category[0].toUpperCase() + category.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Subject
            <input name="subject" required minLength={3} maxLength={180} />
          </label>
          <label>
            Message
            <textarea name="message" required minLength={10} maxLength={6000} rows={5} />
          </label>
          <label>
            Order reference (optional)
            <input
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
              maxLength={240}
            />
          </label>
          {requestId && <p className="muted">Error reference: {requestId}</p>}
          <button className="button gold" disabled={busy}>
            <MessageSquare size={16} /> {busy ? "Sending…" : "Send request"}
          </button>
        </form>
      )}
    </section>
  );
}
