import { useEffect, useState } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import { useAccount } from "./client";

export function ConnectionNotice() {
  const { error, errorRequestId, reload } = useAccount();
  const [offline, setOffline] = useState(false),
    [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const reference = errorRequestId || "";
  if (!offline && !error) return null;
  return (
    <aside className="connection-notice" role="status">
      <WifiOff size={18} aria-hidden="true" />
      <div>
        <strong>{offline ? "You’re offline" : "Your account could not be refreshed"}</strong>
        <p>
          {offline
            ? "Online services need a connection. Reconnect to refresh your account and sync changes."
            : error}
        </p>
        {reference && <small>Request reference: {reference}</small>}
      </div>
      {!offline && (
        <button
          className="button outline compact"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await reload();
            } finally {
              setRetrying(false);
            }
          }}
        >
          <RefreshCw size={14} /> {retrying ? "Retrying…" : "Try again"}
        </button>
      )}
      <a href={`/help${reference ? `?reference=${encodeURIComponent(reference)}` : ""}`}>
        Get help
      </a>
    </aside>
  );
}
