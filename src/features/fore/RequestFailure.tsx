import { CoveRequestError } from "./api-transport";

export function RequestFailure({ error, retry }: { error: unknown; retry: () => void }) {
  const reference = error instanceof CoveRequestError ? error.requestId : null;
  return (
    <div className="empty-state" role="alert">
      <h2>We couldn’t load this right now.</h2>
      <p>{error instanceof Error ? error.message : "Please try again."}</p>
      {reference && <p>Request reference: {reference}</p>}
      <button className="button gold" onClick={retry}>
        Try again
      </button>
      <a
        className="button"
        href={reference ? `/help?reference=${encodeURIComponent(reference)}` : "/help"}
      >
        Get help
      </a>
    </div>
  );
}
