import { useUiText } from "./ui-text";
import { CoveRequestError } from "./api-transport";
import { useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, useAccount } from "./client";

export type ShareMember = { id: string; username: string; name: string };
export type HighlightShareAudience = {
  id: string;
  audienceKey: string;
  visibility: "public" | "followers" | "friends" | "group" | "member";
  recipientUserId: string | null;
  recipient: ShareMember | null;
  groupId: string | null;
  groupName: string | null;
  shareNote: boolean;
  updatedAt: string;
  version: number;
};
export type HighlightShareState = {
  shared: boolean;
  annotationVersion: number;
  note: string;
  shares: HighlightShareAudience[];
};
export function MemberPicker({
  value,
  onChange,
}: {
  value: ShareMember | null;
  onChange: (member: ShareMember | null) => void;
}) {
  const ui = useUiText();
  const [username, setUsername] = useState(value?.username || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  async function find() {
    const attempt = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ member: ShareMember }>(
        `/social/members?username=${encodeURIComponent(username.trim())}`,
      );
      if (attempt === generation.current) onChange(result.member);
    } catch (e) {
      if (attempt === generation.current) setError((e as Error).message);
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  }
  return (
    <div>
      <label>
        {ui("Member username")}
        <input
          className="note-input"
          value={username}
          maxLength={31}
          autoComplete="off"
          placeholder="@username"
          onChange={(e) => {
            generation.current++;
            setBusy(false);
            setUsername(e.target.value);
            onChange(null);
            setError("");
          }}
        />
      </label>
      <button
        type="button"
        className="button outline"
        onClick={find}
        disabled={busy || !username.trim()}
      >
        {busy ? ui("Finding…") : ui("Find member")}
      </button>
      {value && (
        <p role="status">
          {ui("Only {name} (@{username}) will receive this share.", {
            name: value.name,
            username: value.username,
          })}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

type SharedItem = {
  kind: "highlight" | "discussion";
  id: string;
  shareId: string | null;
  owner: ShareMember | null;
  recipient: ShareMember | null;
  audience: string;
  group: { id: string; name: string } | null;
  book: { title?: string; productId?: string } | null;
  productId: string;
  readerBookId: string | null;
  shareNote: boolean;
  progress: number | null;
  updatedAt: string;
  moderationStatus: string;
  version: number;
  locked: boolean;
  quote?: string;
  note?: string;
  body?: string;
  chapter?: string;
  cfi?: string;
};
type SharePage = { items: SharedItem[]; nextCursor: string | null };
function SharedCard({
  item,
  sent,
  onChanged,
}: {
  item: SharedItem;
  sent: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const ui = useUiText();
  const { data: account } = useAccount();
  const [editing, setEditing] = useState(false);
  const [audience, setAudience] = useState(item.audience);
  const [member, setMember] = useState(item.recipient);
  const [groupId, setGroupId] = useState(item.group?.id || "");
  const [shareNote, setShareNote] = useState(item.shareNote);
  const [busy, setBusy] = useState(false);
  const source = useQuery<HighlightShareState>({
    queryKey: ["highlight-share", account.user?.id, item.id],
    queryFn: () => api(`/social/highlights/${encodeURIComponent(item.id)}/share`),
    enabled: editing && item.kind === "highlight",
    staleTime: 0,
  });
  const groups = useQuery<{
    groups: { id: string; name: string; member_status?: string; status?: string }[];
  }>({
    queryKey: ["sharing-groups", account.user?.id],
    queryFn: () => api("/social/me"),
    enabled: editing && audience === "group",
  });
  async function mutate(remove: boolean) {
    if (busy || (!remove && shareNote && (!source.data || source.isFetching || source.isError)))
      return;
    setBusy(true);
    try {
      const route =
        item.kind === "highlight"
          ? `/social/highlights/${encodeURIComponent(item.id)}/share`
          : `/social/posts/${encodeURIComponent(item.id)}`;
      if (item.kind === "discussion") {
        await api(route, "DELETE", { expectedVersion: item.version });
      } else
        await api(
          route,
          remove ? "DELETE" : "POST",
          remove
            ? {
                ...(item.shareId ? { shareId: item.shareId } : {}),
                expectedVersion: item.version,
              }
            : {
                ...(item.shareId ? { shareId: item.shareId } : {}),
                visibility: audience,
                expectedVersion: item.version,
                recipientUserId: audience === "member" ? member?.id : null,
                groupId: audience === "group" ? groupId : null,
                shareNote,
                expectedAnnotationVersion: shareNote ? source.data?.annotationVersion : undefined,
                audienceConfirmed: true,
              },
        );
      setEditing(false);
      await onChanged();
      toast.success(remove ? ui("Share withdrawn") : ui("Sharing updated"));
    } catch (e) {
      if (e instanceof CoveRequestError && e.status === 409) {
        setEditing(false);
        await onChanged();
      }
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const location = new URLSearchParams({ shared: item.id, kind: item.kind });
  if (item.cfi) location.set("cfi", item.cfi);
  return (
    <article className="margin-conversation-card">
      <h3>{item.book?.title || ui("Shared reading")}</h3>
      <p className="small muted">
        {sent ? ui("Audience") : `From @${item.owner?.username || "reader"}`}:{" "}
        {item.audience === "member"
          ? sent
            ? `Only @${item.recipient?.username || ui("selected member")}`
            : ui("Only you")
          : item.group?.name || item.audience}{" "}
        · {item.kind} · {item.shareNote ? ui("Note included") : ui("No private note")}
      </p>
      {sent && item.moderationStatus !== "visible" && (
        <p role="status">
          {ui("This share is currently {audience}.", { audience: ui(item.moderationStatus) })}
        </p>
      )}
      {item.locked ? (
        <p>
          {ui(
            "This passage is ahead of your reading progress ({percent}%). Continue reading to unlock it.",
            { percent: Math.round((item.progress || 0) * 100) },
          )}
        </p>
      ) : (
        <>
          <blockquote className="editor-quote">{item.quote}</blockquote>
          {item.note && <p>{item.note}</p>}
          {item.body && <p>{item.body}</p>}
        </>
      )}
      {item.readerBookId ? (
        <a
          className="button outline"
          href={`/read/${encodeURIComponent(item.readerBookId)}?${location}`}
        >
          {ui("Open in reader")}
        </a>
      ) : (
        <p role="status">{ui("This edition is currently unavailable in the reader.")}</p>
      )}
      {sent && (
        <>
          <button className="button outline" disabled={busy} onClick={() => mutate(true)}>
            {busy
              ? "Updating…"
              : item.kind === "highlight"
                ? ui("Unshare")
                : ui("Remove discussion")}
          </button>
          {item.kind === "highlight" && (
            <button className="button outline" disabled={busy} onClick={() => setEditing(!editing)}>
              {ui("Edit audience & note")}
            </button>
          )}
        </>
      )}
      {editing && (
        <fieldset disabled={busy}>
          <legend>{ui("Sharing permissions")}</legend>
          <label>
            {ui("Audience")}
            <select value={audience} onChange={(e) => setAudience(e.target.value)}>
              <option value="member">{ui("One member")}</option>
              <option value="friends">{ui("Friends / mutuals")}</option>
              <option value="followers">{ui("Followers")}</option>
              <option value="group">{ui("Reading group")}</option>
              <option value="public">{ui("Public")}</option>
            </select>
          </label>
          {audience === "member" && <MemberPicker value={member} onChange={setMember} />}
          {audience === "group" && (
            <label>
              {ui("Group")}
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">{ui("Choose a joined group")}</option>
                {groups.data?.groups
                  .filter((g) => g.member_status === "active" && g.status !== "suspended")
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={shareNote}
              onChange={(e) => setShareNote(e.target.checked)}
            />
            {ui("Include my note")}
          </label>
          {shareNote && source.data && (
            <div className="reader-format-notice">
              <p>
                {audience === item.audience &&
                member?.id === item.recipient?.id &&
                groupId === (item.group?.id || "") &&
                item.shareNote
                  ? ui(
                      "This audience keeps its published note. Use your note editor to review and republish private edits.",
                    )
                  : ui("This audience will receive this copy of your current private note:")}
              </p>
              <blockquote>
                {audience === item.audience &&
                member?.id === item.recipient?.id &&
                groupId === (item.group?.id || "") &&
                item.shareNote
                  ? item.note
                  : source.data.note || ui("No note text")}
              </blockquote>
            </div>
          )}
          {source.isError && (
            <p role="alert">
              {ui("Could not check the private note.")}{" "}
              <button onClick={() => source.refetch()}>{ui("Retry note status")}</button>
            </p>
          )}
          <button
            className="button gold"
            disabled={
              busy ||
              (shareNote && (!source.data || source.isFetching || source.isError)) ||
              (audience === "member" && !member) ||
              (audience === "group" && !groupId)
            }
            onClick={() => mutate(false)}
          >
            {ui("Save permissions")}
          </button>
          <button className="button outline" onClick={() => setEditing(false)}>
            {ui("Cancel")}
          </button>
        </fieldset>
      )}
    </article>
  );
}

export function SharingPage({ sent = false }: { sent?: boolean }) {
  const ui = useUiText();
  const { data, signIn } = useAccount();
  const q = useInfiniteQuery<SharePage>({
    queryKey: ["share-inventory", data.user?.id, sent],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api(
        `/social/sharing?view=${sent ? "sent" : "received"}${pageParam ? `&cursor=${encodeURIComponent(String(pageParam))}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: !!data.user,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const preferences = useQuery<{ policy: string }>({
    queryKey: ["direct-sharing-policy", data.user?.id],
    queryFn: () => api("/social/sharing/preferences"),
    enabled: sent && !!data.user,
  });
  if (!data.user)
    return (
      <section className="community-signin">
        <h2>{sent ? ui("Manage your sharing") : ui("Shared with me")}</h2>
        <p>{ui("Sign in to see your private sharing.")}</p>
        <button className="button gold" onClick={signIn}>
          {ui("Sign in")}
        </button>
      </section>
    );
  const items = q.data?.pages.flatMap((page) => page.items) || [];
  return (
    <section className="sharing-inventory">
      <h2>{sent ? ui("My sharing") : ui("Shared with me")}</h2>
      <p>
        {sent
          ? ui(
              "Inspect and withdraw highlights, notes, and margin discussions. Lists and journeys have their own controls in My profile.",
            )
          : ui(
              "Highlights, notes, and margin discussions shared directly with you or your reading circles. Passages ahead of your progress stay hidden.",
            )}
      </p>
      {sent && preferences.data && (
        <label>
          {ui("Who can send you direct shares?")}
          <select
            value={preferences.data.policy}
            onChange={async (e) => {
              try {
                await api("/social/sharing/preferences", "POST", { policy: e.target.value });
                await preferences.refetch();
                toast.success(ui("Direct sharing preference saved"));
              } catch (error) {
                toast.error((error as Error).message);
              }
            }}
          >
            <option value="members">{ui("All Cove members")}</option>
            <option value="following">{ui("People I follow")}</option>
            <option value="mutuals">{ui("Mutual followers")}</option>
            <option value="none">{ui("Nobody")}</option>
          </select>
        </label>
      )}
      {q.isPending ? (
        <p role="status">{ui("Loading shares…")}</p>
      ) : q.isError ? (
        <div role="alert">
          <p>{q.error.message}</p>
          <button className="button outline" onClick={() => q.refetch()}>
            {ui("Retry")}
          </button>
        </div>
      ) : (
        <>
          {items.length ? (
            items.map((item) => (
              <SharedCard
                key={`${item.kind}:${item.shareId || item.id}:${item.updatedAt}:${item.version}`}
                item={item}
                sent={sent}
                onChanged={() => q.refetch()}
              />
            ))
          ) : (
            <p>
              {sent
                ? ui("You have no active shares.")
                : ui("Nothing has been shared with you yet.")}
            </p>
          )}
          {q.hasNextPage && (
            <button
              className="button outline"
              disabled={q.isFetchingNextPage}
              onClick={() => q.fetchNextPage()}
            >
              {q.isFetchingNextPage ? "Loading…" : ui("Load more shares")}
            </button>
          )}
        </>
      )}
    </section>
  );
}
