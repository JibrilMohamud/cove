import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search, UserRound, UserMinus, UserPlus, ShieldOff } from "lucide-react";
import { api, useAccount } from "./client";
import { useUiText } from "./ui-text";

type Reader = { user_id: string; username: string | null; name: string };
type Page = { people: Reader[]; blocked: Reader[]; nextCursor: string | null };

function ReaderLink({ person }: { person: Reader }) {
  return (
    <a href={`/community?profile=${encodeURIComponent(person.username || person.user_id)}`}>
      <span className="social-avatar">{String(person.name || "R").slice(0, 1)}</span>
      <span>
        <strong>{person.name || person.username || "Reader"}</strong>
        <small>@{person.username || "reader"}</small>
      </span>
    </a>
  );
}

export function SettingsNetwork() {
  const ui = useUiText();
  const { data } = useAccount();
  const cache = useQueryClient();
  const [view, setView] = useState<"following" | "blocked">("following");
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(input.trim().slice(0, 100)), 300);
    return () => clearTimeout(timer);
  }, [input]);
  const network = useInfiniteQuery<Page>({
    queryKey: ["settings-network", data.user?.id],
    queryFn: ({ pageParam }) =>
      api(`/social/network?after=${encodeURIComponent(String(pageParam || ""))}`),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: !!data.user,
    staleTime: 60_000,
  });
  const search = useQuery<{ people: Reader[] }>({
    queryKey: ["settings-network-search", data.user?.id, term],
    queryFn: () => api(`/social/discover?q=${encodeURIComponent(term)}`),
    enabled: !!data.user && term.length > 0,
    staleTime: 30_000,
  });
  const followed = network.data?.pages.flatMap((page) => page.people) || [];
  const blocked = network.data?.pages[0]?.blocked || [];
  const followedIds = new Set(followed.map((x) => x.user_id));
  const blockedIds = new Set(blocked.map((x) => x.user_id));

  async function relationship(person: Reader, action: "follow" | "unfollow" | "unblock") {
    if (busy) return;
    setBusy(person.user_id);
    try {
      if (action === "unblock")
        await api("/social/block", "POST", { userId: person.user_id, blocked: false });
      else
        await api("/social/follow", "POST", {
          userId: person.user_id,
          following: action === "follow",
        });
      await cache.invalidateQueries({ queryKey: ["settings-network", data.user?.id] });
      toast.success(
        action === "unblock"
          ? ui("Reader unblocked")
          : action === "follow"
            ? ui("Follow request sent")
            : ui("Unfollowed"),
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="cove-settings-network" aria-label={ui("Network")}>
      <div className="cove-network-toolbar">
        <div className="cove-network-toggle" role="group" aria-label={ui("Network lists")}>
          <button
            type="button"
            aria-pressed={view === "following"}
            className={view === "following" ? "selected" : ""}
            onClick={() => setView("following")}
          >
            {ui("Following")}
          </button>
          <button
            type="button"
            aria-pressed={view === "blocked"}
            className={view === "blocked" ? "selected" : ""}
            onClick={() => setView("blocked")}
          >
            {ui("Blocked")}
          </button>
        </div>
        <label className="cove-network-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">{ui("Search people to follow")}</span>
          <input
            type="search"
            value={input}
            maxLength={100}
            onChange={(event) => setInput(event.target.value)}
            placeholder={ui("Search people to follow")}
          />
        </label>
      </div>
      {network.isError ? (
        <p role="alert">
          {ui("Could not load your network.")}{" "}
          <button className="text-link" onClick={() => network.refetch()}>
            {ui("Retry")}
          </button>
        </p>
      ) : (
        <div className="cove-network-columns">
          <section>
            <h2>{view === "following" ? ui("People you follow") : ui("Blocked readers")}</h2>
            <p className="muted">
              {view === "following"
                ? ui("Keep or trim the accounts in your feed.")
                : ui("Readers you have blocked from interacting with you.")}
            </p>
            {network.isLoading && <p role="status">{ui("Loading…")}</p>}
            <div className="cove-network-people">
              {(view === "following" ? followed : blocked).map((person) => (
                <div className="cove-network-person" key={person.user_id}>
                  <ReaderLink person={person} />
                  <button
                    type="button"
                    className="text-link"
                    disabled={busy === person.user_id}
                    onClick={() =>
                      relationship(person, view === "following" ? "unfollow" : "unblock")
                    }
                  >
                    {view === "following" ? <UserMinus size={15} /> : <ShieldOff size={15} />}
                    {view === "following" ? ui("Unfollow") : ui("Unblock")}
                  </button>
                </div>
              ))}
            </div>
            {!network.isLoading &&
              !(view === "following" ? followed : blocked).length && (
                <p className="muted">
                  {view === "following"
                    ? ui("You aren't following anyone yet.")
                    : ui("You haven't blocked anyone.")}
                </p>
              )}
            {view === "following" && network.hasNextPage && (
              <button
                className="button outline"
                disabled={network.isFetchingNextPage}
                onClick={() => network.fetchNextPage()}
              >
                {ui("Load more")}
              </button>
            )}
          </section>
          <section>
            <h2>{ui("Find people to follow")}</h2>
            <p className="muted">{ui("Search usernames or display names.")}</p>
            {!term && (
              <p className="muted cove-network-empty">
                <UserRound size={19} aria-hidden="true" />
                {ui("Start typing to search for people.")}
              </p>
            )}
            {search.isFetching && <p role="status">{ui("Searching…")}</p>}
            {search.isError && <p role="alert">{ui("Search failed.")}</p>}
            <div className="cove-network-people">
              {(search.data?.people || [])
                .filter((person) => person.user_id !== data.user?.id && !blockedIds.has(person.user_id))
                .map((person) => (
                  <div className="cove-network-person" key={person.user_id}>
                    <ReaderLink person={person} />
                    <button
                      type="button"
                      className="text-link"
                      disabled={busy === person.user_id || followedIds.has(person.user_id)}
                      onClick={() => relationship(person, "follow")}
                    >
                      <UserPlus size={15} />
                      {followedIds.has(person.user_id) ? ui("Following") : ui("Follow")}
                    </button>
                  </div>
                ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
